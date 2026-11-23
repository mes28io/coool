// An invented movie for the media e2e (app/scripts/media-e2e.sh): scenes of flat colour, each with a mock window and
// a square that moves, so key frames and posters have something to show. No input, no network.
//
//   swift make-movie.swift <out.mp4|out.mov> <width> <height> <seconds> <scenes>
import AVFoundation
import CoreGraphics
import CoreVideo

let a = CommandLine.arguments
let url = URL(fileURLWithPath: a[1])
let (W, H, secs, scenes) = (Int(a[2])!, Int(a[3])!, Double(a[4])!, Int(a[5])!)
try? FileManager.default.removeItem(at: url)
let writer = try! AVAssetWriter(outputURL: url, fileType: url.pathExtension == "mov" ? .mov : .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)
let fps = 15
let frames = Int(secs * Double(fps))
let palette: [(CGFloat, CGFloat, CGFloat)] = [(0.13, 0.17, 0.27), (0.85, 0.42, 0.20), (0.18, 0.55, 0.42), (0.55, 0.30, 0.75), (0.90, 0.80, 0.30)]
for i in 0..<frames {
    while !input.isReadyForMoreMediaData { usleep(1000) }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
    CVPixelBufferLockBaseAddress(pb!, [])
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb!), width: W, height: H, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb!),
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    let scene = min(scenes - 1, i * scenes / frames)
    let c = palette[scene % palette.count]
    ctx.setFillColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    // A mock window: title bar and rows.
    let win = CGRect(x: W / 8, y: H / 6, width: W * 3 / 4, height: H * 2 / 3)
    ctx.setFillColor(red: 0.97, green: 0.97, blue: 0.98, alpha: 1)
    ctx.fill(win)
    ctx.setFillColor(red: 0.85, green: 0.86, blue: 0.88, alpha: 1)
    ctx.fill(CGRect(x: win.minX, y: win.maxY - 28, width: win.width, height: 28))
    for r in 0..<(3 + scene) {
        ctx.setFillColor(red: 0.75, green: 0.78, blue: 0.82, alpha: 1)
        ctx.fill(CGRect(x: win.minX + 24, y: win.maxY - 60 - CGFloat(r) * 30, width: win.width * CGFloat(0.4 + 0.1 * Double(r % 4)), height: 12))
    }
    // The moving square and a progress bar.
    let t = Double(i) / Double(frames)
    ctx.setFillColor(red: 0.1, green: 0.45, blue: 1, alpha: 1)
    ctx.fill(CGRect(x: win.minX + CGFloat(t) * (win.width - 60), y: win.minY + 20, width: 40, height: 40))
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 0.9)
    ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(W) * CGFloat(t), height: 6))
    CVPixelBufferUnlockBaseAddress(pb!, [])
    adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(fps)))
}
input.markAsFinished()
writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(fps)))
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
if writer.status != .completed { print(writer.error!); exit(1) }
