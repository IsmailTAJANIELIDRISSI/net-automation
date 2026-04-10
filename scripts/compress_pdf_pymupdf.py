#!/usr/bin/env python3
"""
Isolated PDF compression test utility using PyMuPDF.

Usage:
  py scripts/compress_pdf_pymupdf.py --input "C:\\path\\in.pdf" --output "C:\\path\\out.pdf"
  py scripts/compress_pdf_pymupdf.py --input in.pdf --output out.pdf --max-mb 2 --dpi-list 150,120,100,72 --quality-list 75,65,55
  py scripts/compress_pdf_pymupdf.py --input in.pdf --output out.pdf --use-structural-first
"""

import argparse
import os
import sys
import tempfile
import time
import fitz  # PyMuPDF


def mb(size_bytes: int) -> float:
    return size_bytes / (1024 * 1024)


def is_likely_pdf(path: str) -> bool:
    try:
        if not os.path.isfile(path) or os.path.getsize(path) < 32:
            return False
        with open(path, "rb") as f:
            head = f.read(8)
            if not head.startswith(b"%PDF-"):
                return False
            seek_len = min(4096, os.path.getsize(path))
            f.seek(-seek_len, os.SEEK_END)
            tail = f.read(seek_len)
            return b"%%EOF" in tail
    except Exception:
        return False


def save_structural_optimized(src: str, out_path: str) -> bool:
    """
    Fast, non-destructive optimization.
    This helps on PDFs with redundant objects but may not shrink scanned files enough.
    """
    try:
        doc = fitz.open(src)
        doc.save(out_path, garbage=4, deflate=True, clean=True)
        doc.close()
        return is_likely_pdf(out_path)
    except Exception:
        return False


def save_rasterized(src: str, out_path: str, dpi: int, jpg_quality: int) -> bool:
    """
    Heavy compression path for scanned PDFs:
    re-render each page then insert as JPEG in a new PDF.
    """
    src_doc = None
    out_doc = None
    try:
        src_doc = fitz.open(src)
        out_doc = fitz.open()
        total = len(src_doc)
        print(f"Rasterizing attempt: dpi={dpi}, q={jpg_quality}, pages={total}")
        for idx, page in enumerate(src_doc, start=1):
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            img_bytes = pix.tobytes("jpeg", jpg_quality=jpg_quality)
            rect = page.rect
            new_page = out_doc.new_page(width=rect.width, height=rect.height)
            new_page.insert_image(rect, stream=img_bytes)
            if idx == 1 or idx % 10 == 0 or idx == total:
                print(f"  page {idx}/{total}")

        out_doc.save(out_path, garbage=4, deflate=True, clean=True)
        return is_likely_pdf(out_path)
    except Exception:
        return False
    finally:
        if src_doc is not None:
            src_doc.close()
        if out_doc is not None:
            out_doc.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Compress PDF with PyMuPDF")
    parser.add_argument("--input", required=True, help="Input PDF path")
    parser.add_argument("--output", required=True, help="Output PDF path")
    parser.add_argument("--max-mb", type=float, default=2.0, help="Target maximum size in MB")
    parser.add_argument(
        "--dpi-list",
        default="150,120,100,72",
        help="Comma-separated DPI candidates for rasterization",
    )
    parser.add_argument(
        "--quality-list",
        default="75,65,55",
        help="Comma-separated JPEG quality candidates",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=0,
        help="Maximum raster attempts (0 = all combinations)",
    )
    parser.add_argument(
        "--use-structural-first",
        action="store_true",
        help="Run structural optimization first (disabled by default for large scanned PDFs)",
    )
    args = parser.parse_args()

    input_path = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output)
    max_bytes = int(args.max_mb * 1024 * 1024)

    if not os.path.exists(input_path):
        print(f"ERROR: Input not found: {input_path}")
        return 2
    if not is_likely_pdf(input_path):
        print(f"ERROR: Input is not a valid PDF: {input_path}")
        return 3

    src_size = os.path.getsize(input_path)
    print(f"Input:  {input_path}")
    print(f"Size:   {mb(src_size):.2f} MB")
    print(f"Target: <= {args.max_mb:.2f} MB")

    if src_size <= max_bytes:
        print("Already below target. Copying original.")
        with open(input_path, "rb") as fin, open(output_path, "wb") as fout:
            fout.write(fin.read())
        return 0

    # 1) Optional structural optimization (often slow / low gain on scanned PDFs).
    if args.use_structural_first:
        tmp_struct = os.path.join(
            tempfile.gettempdir(), f"pymupdf_struct_{os.getpid()}_{int(os.times().elapsed)}.pdf"
        )
        print("Starting structural optimization...")
        t0 = time.time()
        if save_structural_optimized(input_path, tmp_struct):
            s = os.path.getsize(tmp_struct)
            print(f"Structural optimize: {mb(s):.2f} MB ({time.time() - t0:.1f}s)")
            if s <= max_bytes:
                with open(tmp_struct, "rb") as fin, open(output_path, "wb") as fout:
                    fout.write(fin.read())
                os.remove(tmp_struct)
                print("OK: target reached with structural optimization")
                return 0
        if os.path.exists(tmp_struct):
            os.remove(tmp_struct)
    else:
        print("Skipping structural optimization (default). Starting raster compression...")

    # 2) Rasterize candidates; keep the best valid result.
    dpis = [int(x.strip()) for x in args.dpi_list.split(",") if x.strip()]
    qualities = [int(x.strip()) for x in args.quality_list.split(",") if x.strip()]

    best_path = None
    best_size = None

    attempts = 0
    for dpi in dpis:
        for quality in qualities:
            if args.max_attempts > 0 and attempts >= args.max_attempts:
                print(f"Stopping early: reached --max-attempts={args.max_attempts}")
                break
            attempts += 1
            attempt_start = time.time()
            tmp_out = os.path.join(
                tempfile.gettempdir(),
                f"pymupdf_raster_{dpi}dpi_q{quality}_{os.getpid()}_{int(os.times().elapsed)}.pdf",
            )
            ok = save_rasterized(input_path, tmp_out, dpi, quality)
            if not ok:
                if os.path.exists(tmp_out):
                    os.remove(tmp_out)
                print(f"Attempt failed: dpi={dpi}, quality={quality}")
                continue

            out_size = os.path.getsize(tmp_out)
            print(
                f"Attempt dpi={dpi}, q={quality}: {mb(out_size):.2f} MB ({time.time() - attempt_start:.1f}s)"
            )

            # Early abort for this use-case: if rasterized result is clearly larger
            # than the source, further raster combinations are unlikely to reach <=2MB.
            if out_size > src_size * 1.15:
                print(
                    "Stopping early: raster output is significantly larger than source; "
                    "further attempts are unlikely to help."
                )
                if best_path and os.path.exists(best_path):
                    with open(best_path, "rb") as fin, open(output_path, "wb") as fout:
                        fout.write(fin.read())
                    final_size = os.path.getsize(output_path)
                    os.remove(best_path)
                    print(
                        f"BEST EFFORT: {mb(final_size):.2f} MB (larger than source; consider iLovePDF/Ghostscript)"
                    )
                    return 0
                return 1

            if best_size is None or out_size < best_size:
                if best_path and os.path.exists(best_path):
                    os.remove(best_path)
                best_path = tmp_out
                best_size = out_size
            else:
                os.remove(tmp_out)

            if out_size <= max_bytes:
                with open(best_path, "rb") as fin, open(output_path, "wb") as fout:
                    fout.write(fin.read())
                os.remove(best_path)
                print("OK: target reached")
                return 0
        if args.max_attempts > 0 and attempts >= args.max_attempts:
            break

    if best_path and os.path.exists(best_path):
        with open(best_path, "rb") as fin, open(output_path, "wb") as fout:
            fout.write(fin.read())
        final_size = os.path.getsize(output_path)
        os.remove(best_path)
        print(
            f"BEST EFFORT: could not reach target; best result is {mb(final_size):.2f} MB"
        )
        return 0

    print("ERROR: all compression attempts failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
