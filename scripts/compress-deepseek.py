#!/usr/bin/env python3
"""
PDF Compressor - Compress PDFs under 2MB or extract first/last page if too large
"""

import os
import sys
import tempfile
from pathlib import Path
import argparse
from typing import Tuple, Optional

try:
    from pypdf import PdfReader, PdfWriter
    import img2pdf
    from pdf2image import convert_from_path
    from PIL import Image
except ImportError as e:
    print("Missing dependencies. Install with:")
    print("pip install pypdf pdf2image img2pdf pillow")
    print("\nAlso need poppler: brew install poppler (Mac) or apt-get install poppler-utils (Linux)")
    sys.exit(1)


class PDFCompressor:
    def __init__(self, input_path: str, output_path: Optional[str] = None):
        self.input_path = Path(input_path)
        self.output_path = Path(output_path) if output_path else self.input_path.parent / f"{self.input_path.stem}_compressed{self.input_path.suffix}"
        self.target_size_mb = 2
        self.max_original_mb = 19
        
    def get_size_mb(self, path: Path) -> float:
        """Get file size in MB"""
        return path.stat().st_size / (1024 * 1024)
    
    def compress_pdf_aggressive(self, input_pdf: Path, output_pdf: Path, quality: int = 40, dpi: int = 100) -> bool:
        """
        Aggressive compression: convert pages to JPEG then back to PDF
        """
        try:
            # Convert PDF pages to images with reduced DPI
            images = convert_from_path(str(input_pdf), dpi=dpi, fmt='jpeg')
            
            if not images:
                return False
            
            # Create temporary directory for images
            with tempfile.TemporaryDirectory() as tmpdir:
                image_paths = []
                for i, img in enumerate(images):
                    # Convert RGB to RGB (ensure correct mode)
                    if img.mode != 'RGB':
                        img = img.convert('RGB')
                    
                    # Save with quality reduction
                    img_path = Path(tmpdir) / f"page_{i:04d}.jpg"
                    img.save(img_path, 'JPEG', quality=quality, optimize=True)
                    image_paths.append(img_path)
                
                # Convert images back to PDF
                with open(output_pdf, 'wb') as f:
                    layout_fun = img2pdf.get_layout_fun((img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)))  # A4 size
                    f.write(img2pdf.convert([str(p) for p in image_paths], layout_fun=layout_fun))
            
            return True
            
        except Exception as e:
            print(f"Aggressive compression failed: {e}")
            return False
    
    def compress_pdf_standard(self, input_pdf: Path, output_pdf: Path) -> bool:
        """
        Standard compression: remove metadata and compress content streams
        """
        try:
            reader = PdfReader(str(input_pdf))
            writer = PdfWriter()
            
            # Copy all pages without compression to allow pypdf to recompress
            for page in reader.pages:
                writer.add_page(page)
            
            # Compress content streams
            writer.compress_content_streams = True
            
            # Write with compression
            with open(output_pdf, 'wb') as f:
                writer.write(f)
            
            return True
            
        except Exception as e:
            print(f"Standard compression failed: {e}")
            return False
    
    def extract_first_last_pages(self, input_pdf: Path, output_pdf: Path) -> bool:
        """
        Extract only first and last page
        """
        try:
            reader = PdfReader(str(input_pdf))
            writer = PdfWriter()
            
            # Add first page
            writer.add_page(reader.pages[0])
            
            # Add last page (if different from first)
            if len(reader.pages) > 1:
                writer.add_page(reader.pages[-1])
            
            with open(output_pdf, 'wb') as f:
                writer.write(f)
            
            return True
            
        except Exception as e:
            print(f"Failed to extract pages: {e}")
            return False
    
    def compress_with_quality_levels(self, input_pdf: Path, output_pdf: Path) -> bool:
        """
        Try progressively aggressive compression levels
        """
        # Try standard compression first
        temp_output = output_pdf.parent / f"temp_{output_pdf.name}"
        
        if self.compress_pdf_standard(input_pdf, temp_output):
            size_mb = self.get_size_mb(temp_output)
            if size_mb <= self.target_size_mb:
                temp_output.rename(output_pdf)
                print(f"✓ Standard compression: {size_mb:.2f}MB")
                return True
        
        # Try aggressive with high quality
        for quality, dpi in [(60, 120), (40, 100), (25, 80), (15, 70)]:
            if self.compress_pdf_aggressive(input_pdf, temp_output, quality=quality, dpi=dpi):
                size_mb = self.get_size_mb(temp_output)
                if size_mb <= self.target_size_mb:
                    temp_output.rename(output_pdf)
                    print(f"✓ Aggressive compression (Q{quality}, DPI{dpi}): {size_mb:.2f}MB")
                    return True
        
        # If still too large, use the smallest possible version
        if temp_output.exists():
            temp_output.rename(output_pdf)
            size_mb = self.get_size_mb(output_pdf)
            print(f"⚠ Minimal compression (still {size_mb:.2f}MB) - falling back to first/last pages")
        else:
            print("✗ All compression methods failed")
        
        return False
    
    def process(self) -> Tuple[bool, str]:
        """
        Main processing function
        """
        if not self.input_path.exists():
            return False, f"Input file not found: {self.input_path}"
        
        original_size_mb = self.get_size_mb(self.input_path)
        
        # Read PDF info
        try:
            reader = PdfReader(str(self.input_path))
            page_count = len(reader.pages)
        except Exception as e:
            return False, f"Cannot read PDF: {e}"
        
        print(f"\n📄 Input: {self.input_path.name}")
        print(f"   Pages: {page_count} | Size: {original_size_mb:.2f}MB")
        
        # Check if original is huge (>19MB) - use first/last pages only
        if original_size_mb > self.max_original_mb:
            print(f"⚠ Original >{self.max_original_mb}MB, extracting first and last page only...")
            if self.extract_first_last_pages(self.input_path, self.output_path):
                new_size = self.get_size_mb(self.output_path)
                print(f"✓ Created {self.output_path.name} ({new_size:.2f}MB) - first and last page only")
                return True, f"Extracted first/last pages: {new_size:.2f}MB"
            else:
                return False, "Failed to extract pages"
        
        # Try to compress under 2MB
        print(f"🎯 Target: under {self.target_size_mb}MB")
        
        if self.compress_with_quality_levels(self.input_path, self.output_path):
            final_size = self.get_size_mb(self.output_path)
            
            if final_size <= self.target_size_mb:
                compression_ratio = (1 - final_size / original_size_mb) * 100
                print(f"✅ Success! {final_size:.2f}MB ({compression_ratio:.1f}% reduction)")
                return True, f"Compressed to {final_size:.2f}MB"
            else:
                # Still too large - use first/last pages
                print(f"⚠ Could not compress below {self.target_size_mb}MB, extracting first/last pages...")
                if self.extract_first_last_pages(self.input_path, self.output_path):
                    final_size = self.get_size_mb(self.output_path)
                    print(f"✓ Extracted pages: {final_size:.2f}MB")
                    return True, f"Extracted first/last pages: {final_size:.2f}MB"
                else:
                    return False, "Failed to extract pages"
        else:
            return False, "Compression failed"


def main():
    parser = argparse.ArgumentParser(description="Compress PDF files under 2MB")
    parser.add_argument("input", help="Input PDF file")
    parser.add_argument("-o", "--output", help="Output PDF file (optional)")
    parser.add_argument("-d", "--directory", help="Process all PDFs in directory")
    
    args = parser.parse_args()
    
    if args.directory:
        # Process all PDFs in directory
        dir_path = Path(args.directory)
        pdf_files = list(dir_path.glob("*.pdf")) + list(dir_path.glob("*.PDF"))
        
        if not pdf_files:
            print(f"No PDF files found in {dir_path}")
            return
        
        print(f"\n📁 Processing {len(pdf_files)} PDF files...")
        results = []
        
        for pdf in pdf_files:
            compressor = PDFCompressor(str(pdf))
            success, message = compressor.process()
            results.append((pdf.name, success, message))
            print("-" * 50)
        
        # Summary
        print("\n📊 Summary:")
        successful = sum(1 for _, success, _ in results if success)
        print(f"   Processed: {len(results)} files")
        print(f"   Successful: {successful}")
        print(f"   Failed: {len(results) - successful}")
        
        for name, success, message in results:
            status = "✓" if success else "✗"
            print(f"   {status} {name}: {message}")
    
    else:
        # Process single file
        compressor = PDFCompressor(args.input, args.output)
        success, message = compressor.process()
        
        if not success:
            print(f"\n❌ Error: {message}")
            sys.exit(1)
        else:
            print(f"\n✨ Done: {message}")


if __name__ == "__main__":
    main()