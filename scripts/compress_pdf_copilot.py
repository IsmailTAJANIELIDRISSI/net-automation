#!/usr/bin/env python3
"""
PDF Compression Script
Compresses large PDF files (400+ pages, 9-30MB) to under 2MB.
If compression fails to get under 2MB for files >19MB, creates a 2-page PDF (first + last page).
"""

import os
import shutil
import sys
import subprocess
from pathlib import Path
from pypdf import PdfReader, PdfWriter


def resolve_ghostscript_executable():
    """
    Windows installs use gswin64c.exe / gswin32c.exe; Unix often has `gs`.
    Optional: set PORTNET_GS_PATH or GS_EXE to the full path to the executable.
    """
    env_exe = (
        os.environ.get("PORTNET_GS_PATH", "").strip()
        or os.environ.get("GS_EXE", "").strip()
    )
    if env_exe and Path(env_exe).is_file():
        return env_exe

    for name in ("gswin64c", "gswin32c", "gs"):
        found = shutil.which(name)
        if found:
            return found

    if sys.platform == "win32":
        pf64 = os.environ.get("ProgramW6432") or os.environ.get("ProgramFiles") or r"C:\Program Files"
        pf32 = os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)"
        for base in (pf64, pf32):
            gs_root = Path(base) / "gs"
            if not gs_root.is_dir():
                continue
            for sub in sorted(gs_root.iterdir(), reverse=True):
                if not sub.is_dir() or not sub.name.startswith("gs"):
                    continue
                for exe_name in ("gswin64c.exe", "gswin32c.exe"):
                    candidate = sub / "bin" / exe_name
                    if candidate.is_file():
                        return str(candidate)

    return None


class PDFCompressor:
    def __init__(self, input_path, output_path=None, target_size_mb=2, large_file_threshold_mb=19):
        self.input_path = Path(input_path)
        self.target_size_mb = target_size_mb
        self.large_file_threshold_mb = large_file_threshold_mb
        
        if output_path:
            self.output_path = Path(output_path)
        else:
            self.output_path = self.input_path.parent / f"{self.input_path.stem}_compressed.pdf"
        
        self.temp_path = self.input_path.parent / f"{self.input_path.stem}_temp.pdf"
        self._gs_exe = resolve_ghostscript_executable()
    
    def get_file_size_mb(self, file_path):
        """Get file size in megabytes"""
        return os.path.getsize(file_path) / (1024 * 1024)
    
    def compress_with_ghostscript(self, quality='ebook'):
        """
        Compress PDF using Ghostscript
        Quality settings: screen (72dpi), ebook (150dpi), printer (300dpi), prepress (300dpi+)
        """
        try:
            if not self._gs_exe:
                print("ERROR: Ghostscript not found. On Windows use gswin64c (not `gs`).")
                print("  Install from https://www.ghostscript.com/download/gsdnld.html")
                print("  Or set PORTNET_GS_PATH to the full path of gswin64c.exe")
                return False

            cmd = [
                self._gs_exe,
                '-sDEVICE=pdfwrite',
                '-dCompatibilityLevel=1.4',
                f'-dPDFSETTINGS=/{quality}',
                '-dNOPAUSE',
                '-dQUIET',
                '-dBATCH',
                '-dDetectDuplicateImages=true',
                '-dCompressFonts=true',
                '-r150',
                f'-sOutputFile={self.temp_path}',
                str(self.input_path)
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode == 0 and self.temp_path.exists():
                return True
            else:
                print(f"Ghostscript error: {result.stderr}")
                return False
                
        except FileNotFoundError:
            print("ERROR: Ghostscript not found. Please install Ghostscript:")
            print("  Windows: Download from https://www.ghostscript.com/download/gsdnld.html")
            print("  Linux: sudo apt-get install ghostscript")
            print("  macOS: brew install ghostscript")
            return False
        except Exception as e:
            print(f"Compression error: {e}")
            return False
    
    def create_two_page_pdf(self):
        """Create a PDF with only first and last page"""
        try:
            reader = PdfReader(str(self.input_path))
            writer = PdfWriter()
            
            total_pages = len(reader.pages)
            if total_pages < 2:
                print("PDF has less than 2 pages, copying as is")
                writer.add_page(reader.pages[0])
            else:
                # Add first page
                writer.add_page(reader.pages[0])
                # Add last page
                writer.add_page(reader.pages[total_pages - 1])
            
            with open(self.temp_path, 'wb') as output_file:
                writer.write(output_file)
            
            return True
            
        except Exception as e:
            print(f"Error creating two-page PDF: {e}")
            return False
    
    def compress(self):
        """Main compression logic"""
        if not self.input_path.exists():
            print(f"ERROR: Input file not found: {self.input_path}")
            return False
        
        original_size = self.get_file_size_mb(self.input_path)
        print(f"Original file: {self.input_path.name}")
        print(f"Original size: {original_size:.2f} MB")
        
        # Try compression first
        print("\nCompressing PDF...")
        if not self.compress_with_ghostscript(quality='ebook'):
            # Try with lower quality
            print("Trying with lower quality (screen)...")
            if not self.compress_with_ghostscript(quality='screen'):
                print("Ghostscript compression failed")
                return False
        
        compressed_size = self.get_file_size_mb(self.temp_path)
        print(f"Compressed size: {compressed_size:.2f} MB")
        
        # Check if we met the target
        if compressed_size <= self.target_size_mb:
            # Success! Move temp file to output
            if self.output_path.exists():
                self.output_path.unlink()
            self.temp_path.rename(self.output_path)
            print(f"\n✓ SUCCESS: Compressed to {compressed_size:.2f} MB")
            print(f"Output: {self.output_path}")
            return True
        
        # If still too large and original was >19MB, create 2-page version
        if original_size > self.large_file_threshold_mb:
            print(f"\nFile still too large ({compressed_size:.2f} MB)")
            print(f"Original file >19MB, creating first+last page PDF...")
            
            # Remove the compressed attempt
            if self.temp_path.exists():
                self.temp_path.unlink()
            
            if self.create_two_page_pdf():
                two_page_size = self.get_file_size_mb(self.temp_path)
                
                if self.output_path.exists():
                    self.output_path.unlink()
                self.temp_path.rename(self.output_path)
                
                print(f"\n✓ SUCCESS: Created 2-page PDF ({two_page_size:.2f} MB)")
                print(f"Output: {self.output_path}")
                return True
        else:
            print(f"\nWARNING: Compressed to {compressed_size:.2f} MB (target: {self.target_size_mb} MB)")
            print(f"Original file <{self.large_file_threshold_mb}MB, keeping compressed version")
            
            if self.output_path.exists():
                self.output_path.unlink()
            self.temp_path.rename(self.output_path)
            print(f"Output: {self.output_path}")
            return True
        
        return False
    
    def cleanup(self):
        """Clean up temporary files"""
        if self.temp_path.exists():
            self.temp_path.unlink()


def main():
    if len(sys.argv) < 2:
        print("Usage: python compress_pdf.py <input.pdf> [output.pdf]")
        print("\nExample:")
        print("  python compress_pdf.py large_document.pdf")
        print("  python compress_pdf.py large_document.pdf compressed.pdf")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else None
    
    compressor = PDFCompressor(input_file, output_file)
    
    try:
        success = compressor.compress()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\nUnexpected error: {e}")
        sys.exit(1)
    finally:
        compressor.cleanup()


if __name__ == "__main__":
    main()
