#!/usr/bin/env python3
import argparse
import json
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def fail(message):
    emit({"ok": False, "error": str(message)})
    return 1


def extract_text(pdf_path):
    try:
        from pypdf import PdfReader
    except Exception as exc:
        return {
            "ok": False,
            "engine": "pypdf",
            "error": f"pypdf is not available: {exc}",
        }

    try:
        reader = PdfReader(pdf_path)
        if getattr(reader, "is_encrypted", False):
            try:
                reader.decrypt("")
            except Exception:
                pass

        pages = []
        parts = []
        for index, page in enumerate(reader.pages):
            try:
                text = page.extract_text() or ""
            except Exception as exc:
                text = ""
                pages.append({
                    "page": index + 1,
                    "charCount": 0,
                    "error": str(exc),
                })
                continue

            text = normalize_page_text(text)
            if text:
                parts.append(text)
            pages.append({
                "page": index + 1,
                "charCount": len(text),
                "lineCount": len([line for line in text.splitlines() if line.strip()]),
            })

        return {
            "ok": True,
            "engine": "pypdf",
            "pageCount": len(reader.pages),
            "pagesWithText": len([page for page in pages if page.get("charCount", 0) > 0]),
            "pages": pages,
            "text": "\n\n".join(parts),
        }
    except Exception as exc:
        return {
            "ok": False,
            "engine": "pypdf",
            "error": str(exc),
        }


def ocr_pdf(pdf_path, language="", max_pages=None, scale=2.0, recognition="accurate", progress_json=False):
    try:
        import Foundation
        import Quartz
        import Vision
    except Exception as exc:
        return {
            "ok": False,
            "engine": "macos-vision",
            "error": f"macOS Vision/Quartz are not available: {exc}",
        }

    try:
        url = Foundation.CFURLCreateFromFileSystemRepresentation(
            None,
            pdf_path.encode("utf-8"),
            len(pdf_path.encode("utf-8")),
            False,
        )
        document = Quartz.CGPDFDocumentCreateWithURL(url)
        if document is None:
            return {
                "ok": False,
                "engine": "macos-vision",
                "error": "Quartz could not open the PDF",
            }

        page_count = Quartz.CGPDFDocumentGetNumberOfPages(document)
        pages_to_process = page_count if max_pages is None else min(page_count, max_pages)
        languages = parse_languages(language)
        pages = []
        parts = []
        emit_progress(progress_json, {
            "event": "ocr-start",
            "engine": "macos-vision",
            "pageCount": page_count,
            "processedPages": 0,
            "recognition": recognition,
            "scale": scale,
        })

        for page_number in range(1, pages_to_process + 1):
            page = Quartz.CGPDFDocumentGetPage(document, page_number)
            if page is None:
                pages.append({"page": page_number, "charCount": 0, "error": "page unavailable"})
                continue

            image = render_pdf_page(Quartz, page, scale)
            text, confidence = recognize_text(Vision, image, languages, recognition)
            text = normalize_page_text(text)
            if text:
                parts.append(text)
            pages.append({
                "page": page_number,
                "charCount": len(text),
                "lineCount": len([line for line in text.splitlines() if line.strip()]),
                "confidence": confidence,
            })
            emit_progress(progress_json, {
                "event": "ocr-page",
                "engine": "macos-vision",
                "pageCount": page_count,
                "processedPages": page_number,
                "maxPages": max_pages,
                "recognition": recognition,
                "scale": scale,
                "charCount": len(text),
                "confidence": confidence,
            })

        return {
            "ok": True,
            "engine": "macos-vision",
            "language": ",".join(languages) if languages else "auto",
            "pageCount": page_count,
            "processedPages": pages_to_process,
            "pagesWithText": len([page for page in pages if page.get("charCount", 0) > 0]),
            "pages": pages,
            "text": "\n\n".join(parts),
            "recognition": recognition,
            "scale": scale,
        }
    except Exception as exc:
        return {
            "ok": False,
            "engine": "macos-vision",
            "error": str(exc),
        }


def render_pdf_page(Quartz, page, scale):
    box = Quartz.CGPDFPageGetBoxRect(page, Quartz.kCGPDFMediaBox)
    width = max(1, int(box.size.width * scale))
    height = max(1, int(box.size.height * scale))
    color_space = Quartz.CGColorSpaceCreateDeviceRGB()
    context = Quartz.CGBitmapContextCreate(
        None,
        width,
        height,
        8,
        0,
        color_space,
        Quartz.kCGImageAlphaPremultipliedLast,
    )
    Quartz.CGContextSetRGBFillColor(context, 1, 1, 1, 1)
    Quartz.CGContextFillRect(context, Quartz.CGRectMake(0, 0, width, height))
    target = Quartz.CGRectMake(0, 0, width, height)
    transform = Quartz.CGPDFPageGetDrawingTransform(page, Quartz.kCGPDFMediaBox, target, 0, True)
    Quartz.CGContextConcatCTM(context, transform)
    Quartz.CGContextDrawPDFPage(context, page)
    return Quartz.CGBitmapContextCreateImage(context)


def recognize_text(Vision, image, languages, recognition="accurate"):
    request = Vision.VNRecognizeTextRequest.alloc().init()
    recognition_level = Vision.VNRequestTextRecognitionLevelFast if recognition == "fast" else Vision.VNRequestTextRecognitionLevelAccurate
    request.setRecognitionLevel_(recognition_level)
    request.setUsesLanguageCorrection_(True)
    if hasattr(request, "setAutomaticallyDetectsLanguage_"):
        request.setAutomaticallyDetectsLanguage_(True)
    if languages:
        request.setRecognitionLanguages_(languages)

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        raise RuntimeError(str(error))

    lines = []
    confidences = []
    observations = list(request.results() or [])
    observations.sort(key=observation_sort_key)
    for observation in observations:
        candidates = observation.topCandidates_(1)
        if not candidates:
            continue
        candidate = candidates[0]
        lines.append(str(candidate.string()))
        try:
            confidences.append(float(candidate.confidence()))
        except Exception:
            pass
    confidence = round(sum(confidences) / len(confidences), 3) if confidences else None
    return "\n".join(lines), confidence


def observation_sort_key(observation):
    try:
        box = observation.boundingBox()
        return (-float(box.origin.y), float(box.origin.x))
    except Exception:
        return (0, 0)


def normalize_page_text(text):
    return "\n".join(line.rstrip() for line in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")).strip()


def parse_languages(language):
    return [normalize_vision_language(item) for item in str(language or "").split(",") if item.strip()]


def normalize_vision_language(language):
    value = language.strip()
    primary = value.lower()
    if primary in ("ch", "cn", "zh", "zh-cn", "zh_hans", "zh-hans"):
        return "zh-Hans"
    if primary in ("zh-tw", "zh-hant", "zh_hant"):
        return "zh-Hant"
    if primary in ("ja", "jp", "japan", "japanese", "ja-jp"):
        return "ja-JP"
    if primary in ("en", "eng", "english", "en-us"):
        return "en-US"
    return value


def emit_progress(enabled, payload):
    if not enabled:
        return
    sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def main(argv):
    parser = argparse.ArgumentParser(description="BookFrames PDF helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    extract_parser = subparsers.add_parser("extract-text")
    extract_parser.add_argument("pdf")

    ocr_parser = subparsers.add_parser("ocr")
    ocr_parser.add_argument("pdf")
    ocr_parser.add_argument("--language", default="")
    ocr_parser.add_argument("--max-pages", type=int, default=None)
    ocr_parser.add_argument("--scale", type=float, default=2.0)
    ocr_parser.add_argument("--recognition", choices=["fast", "accurate"], default="accurate")
    ocr_parser.add_argument("--progress-json", action="store_true")

    args = parser.parse_args(argv)
    if args.command == "extract-text":
        emit(extract_text(args.pdf))
        return 0
    if args.command == "ocr":
        emit(ocr_pdf(
            args.pdf,
            language=args.language,
            max_pages=args.max_pages,
            scale=args.scale,
            recognition=args.recognition,
            progress_json=args.progress_json,
        ))
        return 0
    return fail(f"unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
