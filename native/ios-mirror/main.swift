// ios-mirror: streams the screen of a USB-connected iPhone/iPad as H.264.
//
// macOS exposes the screen of a cabled iOS device as an AVFoundation capture
// device once CoreMediaIO's "allow screen capture devices" is switched on (the
// same mechanism QuickTime Player uses). We capture it, scale it, encode it with
// VideoToolbox and write packets to stdout in scrcpy's framing, so the extension
// reuses its Android demuxer and webview decoder unchanged.
//
//   ios-mirror watch                      JSON lines on stdout whenever devices change
//   ios-mirror stream <uid> [--max-size N] [--bit-rate N] [--max-fps N]
//       stdout: 12-byte session/packet headers + Annex B H.264
//       stdin:  "k" = key frame now, "s <path>" = full-resolution PNG screenshot
//       stderr: log lines; "@snapshot ok <path>" / "@snapshot error <msg>"
//
// Exits when stdin closes, so it never outlives the extension.

import AVFoundation
import CoreImage
import CoreMediaIO
import Foundation
import ImageIO
import UniformTypeIdentifiers
import VideoToolbox

setvbuf(stderr, nil, _IOLBF, 0)

func log(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

func fail(_ s: String, code: Int32 = 1) -> Never {
    log("@error \(s)")
    exit(code)
}

// ---------- device discovery ----------

func enableScreenCaptureDevices() {
    var prop = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
}

func iosDevices() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: nil, position: .unspecified)
        .devices.filter { $0.modelID == "iOS Device" }
}

/// Exit when the parent closes our stdin (or dies).
func exitOnStdinClose(onLine: @escaping (String) -> Void = { _ in }) {
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            onLine(line)
        }
        exit(0)
    }
}

func watch() -> Never {
    var last = ""
    func report() {
        let list = iosDevices().map { ["id": $0.uniqueID, "name": $0.localizedName] }
        let json = String(data: try! JSONSerialization.data(withJSONObject: ["devices": list], options: [.sortedKeys]), encoding: .utf8)!
        if json != last {
            last = json
            print(json)
            fflush(stdout)
        }
    }
    for name in [AVCaptureDevice.wasConnectedNotification, AVCaptureDevice.wasDisconnectedNotification] {
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in report() }
    }
    exitOnStdinClose()
    // Devices show up asynchronously after enabling capture; poll lightly as a backstop.
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in report() }
    report()
    RunLoop.main.run()
    exit(0)
}

// ---------- streaming ----------

struct Options {
    var maxSize = 1600
    var bitRate = 8_000_000
    var maxFps = 60
}

/// Writes scrcpy-framed packets to stdout from one serial queue.
final class PacketWriter {
    private let queue = DispatchQueue(label: "writer")
    private let out = FileHandle.standardOutput

    init() {
        signal(SIGPIPE, SIG_IGN)
    }

    private func write(_ data: Data) {
        queue.async {
            do { try self.out.write(contentsOf: data) } catch { exit(0) } // parent went away
        }
    }

    /// New capture session (start, rotation): MSB set, then width and height.
    func session(width: Int, height: Int) {
        var d = Data([0x80, 0, 0, 0])
        d.append(be32(UInt32(width)))
        d.append(be32(UInt32(height)))
        write(d)
    }

    func packet(_ payload: Data, pts: UInt64, config: Bool, key: Bool) {
        var flags = pts & ((1 << 61) - 1)
        if config { flags |= 1 << 62 }
        if key { flags |= 1 << 61 }
        var d = be64(flags)
        d.append(be32(UInt32(payload.count)))
        d.append(payload)
        write(d)
    }

    private func be32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.bigEndian) { Data($0) } }
    private func be64(_ v: UInt64) -> Data { withUnsafeBytes(of: v.bigEndian) { Data($0) } }
}

final class Streamer: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let opts: Options
    let writer = PacketWriter()
    let ciContext = CIContext()

    private var encoder: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private var pool: CVPixelBufferPool?
    private var sourceSize = (w: 0, h: 0)
    private var targetSize = (w: 0, h: 0)
    private var lastParameterSets = Data()
    private var lastFrameTime = CMTime.invalid
    private var firstPts: CMTime?
    private let lock = NSLock()
    private var forceKeyFrame = true
    private var pendingSnapshots: [String] = []

    init(opts: Options) { self.opts = opts }

    func requestKeyFrame() {
        lock.lock(); forceKeyFrame = true; lock.unlock()
    }

    func requestSnapshot(_ path: String) {
        lock.lock(); pendingSnapshots.append(path); lock.unlock()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let px = CMSampleBufferGetImageBuffer(sb) else { return }
        let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px)

        lock.lock()
        let snapshots = pendingSnapshots
        pendingSnapshots.removeAll()
        lock.unlock()
        for path in snapshots { saveSnapshot(px, to: path) }

        // Frame-rate cap.
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if lastFrameTime.isValid, CMTimeGetSeconds(CMTimeSubtract(pts, lastFrameTime)) < 1.0 / Double(opts.maxFps) - 0.002 {
            return
        }
        lastFrameTime = pts

        if w != sourceSize.w || h != sourceSize.h || encoder == nil {
            setUp(width: w, height: h)
        }
        guard let encoder else { return }

        var input = px
        if targetSize != sourceSize, let transfer, let pool {
            var scaled: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &scaled)
            guard let scaled, VTPixelTransferSessionTransferImage(transfer, from: px, to: scaled) == noErr else { return }
            input = scaled
        }

        if firstPts == nil { firstPts = pts }
        let relative = CMTimeSubtract(pts, firstPts!)

        lock.lock()
        let key = forceKeyFrame
        forceKeyFrame = false
        lock.unlock()
        let props = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil

        VTCompressionSessionEncodeFrame(encoder, imageBuffer: input, presentationTimeStamp: relative, duration: .invalid,
                                        frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sample in
            guard status == noErr, let sample, let self else { return }
            self.emit(sample)
        }
    }

    private func setUp(width: Int, height: Int) {
        if let encoder { VTCompressionSessionInvalidate(encoder) }
        encoder = nil
        sourceSize = (width, height)

        // Scale so the longer side is at most maxSize; H.264 wants even dimensions.
        let scale = opts.maxSize > 0 ? min(1.0, Double(opts.maxSize) / Double(max(width, height))) : 1.0
        let tw = Int(Double(width) * scale) & ~1, th = Int(Double(height) * scale) & ~1
        targetSize = (tw, th)

        if targetSize != sourceSize {
            VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer)
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey: tw,
                kCVPixelBufferHeightKey: th,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            ]
            CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
        }

        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(tw), height: Int32(th), codecType: kCMVideoCodecType_H264,
                                                encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                                outputCallback: nil, refcon: nil, compressionSessionOut: &session)
        guard status == noErr, let session else {
            log("@error encoder setup failed (\(status))")
            return
        }
        let set = { (key: CFString, value: CFTypeRef) in _ = VTSessionSetProperty(session, key: key, value: value) }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse) // no B-frames: lowest latency
        set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
        set(kVTCompressionPropertyKey_AverageBitRate, opts.bitRate as CFNumber)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, opts.maxFps as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (opts.maxFps * 4) as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(session)
        encoder = session
        lastParameterSets = Data()
        forceKeyFrame = true
        writer.session(width: tw, height: th)
        log("streaming \(width)x\(height) -> \(tw)x\(th)")
    }

    private static let startCode = Data([0, 0, 0, 1])

    private func emit(_ sample: CMSampleBuffer) {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let micros = UInt64(max(0, CMTimeGetSeconds(pts)) * 1_000_000)

        if key, let fmt = CMSampleBufferGetFormatDescription(sample) {
            var config = Data()
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                               parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                   parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                if let ptr {
                    config.append(Streamer.startCode)
                    config.append(ptr, count: size)
                }
            }
            if config != lastParameterSets {
                lastParameterSets = config
                writer.packet(config, pts: micros, config: true, key: false)
            }
        }

        // AVCC (4-byte big-endian lengths) -> Annex B (start codes).
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let pointer else { return }
        var annexB = Data(capacity: length + 16)
        var offset = 0
        pointer.withMemoryRebound(to: UInt8.self, capacity: length) { bytes in
            while offset + 4 <= length {
                let nalLength = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
                offset += 4
                guard nalLength > 0, offset + nalLength <= length else { break }
                annexB.append(Streamer.startCode)
                annexB.append(bytes + offset, count: nalLength)
                offset += nalLength
            }
        }
        writer.packet(annexB, pts: micros, config: false, key: key)
    }

    private func saveSnapshot(_ px: CVPixelBuffer, to path: String) {
        let image = CIImage(cvPixelBuffer: px)
        guard let cg = ciContext.createCGImage(image, from: image.extent),
              let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            log("@snapshot error could not encode image")
            return
        }
        CGImageDestinationAddImage(dest, cg, nil)
        log(CGImageDestinationFinalize(dest) ? "@snapshot ok \(path)" : "@snapshot error could not write \(path)")
    }
}

func stream(uid: String, opts: Options) -> Never {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .notDetermined:
        let sem = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .video) { _ in sem.signal() }
        sem.wait()
    default: break
    }
    if AVCaptureDevice.authorizationStatus(for: .video) != .authorized {
        fail("camera-denied", code: 3)
    }

    var device: AVCaptureDevice?
    for _ in 0..<40 {
        device = iosDevices().first { $0.uniqueID == uid }
        if device != nil { break }
        RunLoop.main.run(until: Date().addingTimeInterval(0.25))
    }
    guard let device else { fail("device-not-found", code: 4) }

    let streamer = Streamer(opts: opts)
    let session = AVCaptureSession()
    do {
        session.addInput(try AVCaptureDeviceInput(device: device))
    } catch {
        fail("cannot open device: \(error.localizedDescription)", code: 5)
    }
    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
    output.setSampleBufferDelegate(streamer, queue: DispatchQueue(label: "capture"))
    session.addOutput(output)

    NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { n in
        fail("capture error: \(String(describing: n.userInfo?[AVCaptureSessionErrorKey]))", code: 6)
    }
    NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil) { _ in
        fail("device-disconnected", code: 7)
    }

    exitOnStdinClose { line in
        if line == "k" { streamer.requestKeyFrame() }
        else if line.hasPrefix("s ") { streamer.requestSnapshot(String(line.dropFirst(2))) }
    }
    session.startRunning()
    log("capture started: \(device.localizedName)")
    RunLoop.main.run()
    exit(0)
}

// ---------- main ----------

enableScreenCaptureDevices()
let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "watch":
    watch()
case "stream":
    guard args.count >= 2 else { fail("usage: ios-mirror stream <uid>") }
    var opts = Options()
    var i = 2
    while i + 1 < args.count {
        let value = Int(args[i + 1]) ?? 0
        switch args[i] {
        case "--max-size": opts.maxSize = value
        case "--bit-rate": opts.bitRate = value
        case "--max-fps": opts.maxFps = max(1, value)
        default: break
        }
        i += 2
    }
    stream(uid: args[1], opts: opts)
default:
    fail("usage: ios-mirror watch | stream <uid> [--max-size N] [--bit-rate N] [--max-fps N]")
}
