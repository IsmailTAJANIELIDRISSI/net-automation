# MAWB → Shipper Extraction — Complete Function Map

> Source: `script_all_fuzy_match.py`  
> Purpose: Port this pipeline to a Playwright JS app.  
> Exports needed: `known_companies.json` + `GEMINI_API_KEY`

---

## Entry Point

**`rename_mawb_pdfs_and_create_bloc_note(dir_path, directory_name, skip_rename=False)`**  
Orchestrates the whole pipeline:
1. Globs `MAWB*.pdf` or falls back to `doc*.pdf`
2. → `extract_mawb_from_generated_excel`
3. → `validate_mawb_match`
4. → `compress_pdf_if_needed`
5. → **`extract_shipper_name`** ← shipper chain starts here
6. → `create_bloc_note`

```python
def rename_mawb_pdfs_and_create_bloc_note(dir_path, directory_name, skip_rename=False):
    print("  Processing MAWB PDFs...")
    found_mawb = False
    mawb_number = None
    mawb_files = glob.glob(os.path.join(dir_path, "MAWB*.pdf"))

    use_doc_file = False
    if not mawb_files:
        doc_files = glob.glob(os.path.join(dir_path, "doc*.pdf"))
        if doc_files:
            mawb_files = doc_files
            use_doc_file = True

    excel_mawb = extract_mawb_from_generated_excel(dir_path)

    for file_path in mawb_files:
        found_mawb = True
        filename = os.path.basename(file_path)

        if use_doc_file:
            if not excel_mawb:
                return None, False
            mawb_number = excel_mawb
        else:
            match = re.search(r'MAWB\s*(.+)\.pdf', filename)
            if not match:
                continue
            mawb_number = match.group(1).strip()
            if excel_mawb:
                if not validate_mawb_match(mawb_number, excel_mawb):
                    create_mawb_mismatch_warning(directory_name, mawb_number, excel_mawb)
                    return None, False

        if skip_rename:
            return mawb_number, True

        new_name = os.path.join(dir_path, f"{directory_name} - {mawb_number}.pdf")
        try:
            os.rename(file_path, new_name)
            compressed_path, was_compressed = compress_pdf_if_needed(new_name, max_size_mb=1.5)
            shipper_name = extract_shipper_name(compressed_path)
            create_bloc_note(directory_name, mawb_number, shipper_name)
        except Exception as e:
            print(f"    ✗ Error processing '{filename}': {e}")

    if not found_mawb:
        print("    No MAWB PDFs found")
    return mawb_number, True
```

---

## MAWB Helpers

### `extract_mawb_from_generated_excel(dir_path)`
Reads cell **C1** of `generated_excel*.xlsx` → returns cleaned MAWB string.

```python
def extract_mawb_from_generated_excel(dir_path):
    try:
        excel_files = glob.glob(os.path.join(dir_path, "generated_excel*.xlsx"))
        if not excel_files:
            return None
        excel_path = excel_files[0]
        wb = load_workbook(excel_path, data_only=True)
        ws = wb.active
        mawb_cell = ws.cell(row=1, column=3).value
        if mawb_cell:
            mawb_str = str(mawb_cell).strip()
            mawb_str = re.sub(r'\s+', '', mawb_str)
            return mawb_str
        return None
    except Exception as e:
        logger.error(f"Error extracting MAWB from generated_excel: {e}")
        return None
```

### `validate_mawb_match(pdf_mawb, excel_mawb)`
Strips `-` and spaces from both sides, returns `bool`.

```python
def validate_mawb_match(pdf_mawb, excel_mawb):
    if not pdf_mawb or not excel_mawb:
        return False
    pdf_normalized = re.sub(r'[-\s]', '', str(pdf_mawb).strip())
    excel_normalized = re.sub(r'[-\s]', '', str(excel_mawb).strip())
    return pdf_normalized == excel_normalized
```

---

## Shipper Extraction — Main Dispatcher

### Call flow

```
is_pdf_text_based(pdf_path)
  ├─ True  → extract_shipper_name_text_based(pdf_path)
  │          (if fails) → extract_shipper_name_ocr(pdf_path)
  └─ False → is_bloc_pdf?
               ├─ 2-page bloc → extract_specific_page_to_file(page=1) → extract_shipper_name_ocr
               └─ else        → process_multi_page_pdf_with_detection(pdf_path)

Result: str (high-confidence fuzzy hit) OR list[str] (candidates for AI)
  ├─ str  → returned directly
  └─ list → setup_gemini_api()
              → verify_shipper_with_gemini(candidates, KNOWN_COMPANIES)
              → clean_company_name(final_name)
              → add_company_to_database(final_name)
              → return final_name
```

### `extract_shipper_name(pdf_path)`

```python
def extract_shipper_name(pdf_path):
    try:
        pdf_name = Path(pdf_path).name.lower()
        is_bloc_pdf = "bloc" in pdf_name
        is_text_pdf = is_pdf_text_based(pdf_path)
        extracted_candidates = None

        if is_text_pdf:
            extracted_candidates = extract_shipper_name_text_based(pdf_path)
            if not extracted_candidates:
                extracted_candidates = extract_shipper_name_ocr(pdf_path)
        else:
            if is_bloc_pdf:
                with open(pdf_path, 'rb') as file:
                    pdf_reader = PdfReader(file)
                    page_count = len(pdf_reader.pages)
                if page_count == 2:
                    with tempfile.TemporaryDirectory() as temp_dir:
                        second_page_pdf = extract_specific_page_to_file(pdf_path, 1, temp_dir)
                        if second_page_pdf:
                            extracted_candidates = extract_shipper_name_ocr(second_page_pdf)
                else:
                    extracted_candidates = process_multi_page_pdf_with_detection(pdf_path)
            else:
                extracted_candidates = process_multi_page_pdf_with_detection(pdf_path)

        if not extracted_candidates:
            return None

        # High-confidence fuzzy match already resolved → return directly
        if isinstance(extracted_candidates, str):
            return extracted_candidates

        # Candidate list → send to Gemini AI
        if setup_gemini_api():
            gemini_result = verify_shipper_with_gemini(extracted_candidates, KNOWN_COMPANIES)
            if gemini_result:
                if gemini_result.get('matched_company'):
                    final_name = gemini_result['matched_company']
                elif gemini_result.get('is_new_company'):
                    final_name = gemini_result.get('final_name') or gemini_result.get('selected_candidate')
                else:
                    final_name = gemini_result.get('final_name', extracted_candidates[0])
            else:
                final_name = extracted_candidates[0]
        else:
            final_name = extracted_candidates[0]

        final_name = clean_company_name(final_name)
        add_company_to_database(final_name)
        return final_name

    except Exception as e:
        logger.error(f"Error in enhanced shipper extraction: {e}")
        return None
```

---

## PDF Type & Page Detection

### `is_pdf_text_based(pdf_path)`

```python
def is_pdf_text_based(pdf_path):
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page_num in range(min(3, len(pdf.pages))):
                page = pdf.pages[page_num]
                text = page.extract_text()
                if text and len(text.strip()) > 100:
                    return True
        return False
    except Exception as e:
        logger.error(f"Error checking PDF type for {pdf_path}: {e}")
        return False
```

### `find_shipper_page_text_based(pdf_path)`
Scans pages for shipper indicators, returns `(page_num, page)`.

```python
def find_shipper_page_text_based(pdf_path):
    try:
        with pdfplumber.open(pdf_path) as pdf:
            shipper_indicators = [
                "shipper's name and address",
                "shipper's account number",
                "shippers name and address",
                "shippers account number",
                "shipper name and address"
            ]
            for page_num, page in enumerate(pdf.pages):
                page_text = page.extract_text()
                if page_text:
                    page_text_lower = page_text.lower()
                    for indicator in shipper_indicators:
                        if indicator in page_text_lower:
                            return page_num, page
            return 0, pdf.pages[0]
    except Exception as e:
        print(f"   ❌ Error finding shipper page: {e}")
        return 0, pdf.pages[0] if pdf.pages else None
```

### `extract_specific_page_to_file(pdf_path, page_index, temp_dir)`
PyPDF2 — isolates one page to a temp PDF.

```python
def extract_specific_page_to_file(pdf_path, page_index, temp_dir):
    try:
        with open(pdf_path, 'rb') as file:
            pdf_reader = PdfReader(file)
            if page_index >= len(pdf_reader.pages):
                return None
            temp_pdf = os.path.join(temp_dir, f"page_{page_index + 1}.pdf")
            pdf_writer = PdfWriter()
            pdf_writer.add_page(pdf_reader.pages[page_index])
            with open(temp_pdf, 'wb') as output:
                pdf_writer.write(output)
            return temp_pdf
    except Exception as e:
        print(f"   ❌ Error extracting page {page_index + 1}: {e}")
        return None
```

### `process_multi_page_pdf_with_detection(pdf_path)`
Routes to text extraction or OCR depending on page content.

```python
def process_multi_page_pdf_with_detection(pdf_path):
    try:
        with pdfplumber.open(pdf_path) as pdf:
            total_pages = len(pdf.pages)
            if total_pages == 1:
                return process_single_page_pdf(pdf_path)
            page_num, shipper_page = find_shipper_page_text_based(pdf_path)
            if shipper_page:
                page_text = shipper_page.extract_text()
                if page_text and len(page_text.strip()) >= 50:
                    return extract_from_specific_page_text(shipper_page)
                else:
                    with tempfile.TemporaryDirectory() as temp_dir:
                        single_page_pdf = extract_specific_page_to_file(pdf_path, page_num, temp_dir)
                        if single_page_pdf:
                            return extract_shipper_name_ocr(single_page_pdf)
            return None
    except Exception as e:
        print(f"   ❌ Error in multi-page processing: {e}")
        return None
```

### `process_single_page_pdf(pdf_path)`

```python
def process_single_page_pdf(pdf_path):
    try:
        with pdfplumber.open(pdf_path) as pdf:
            page_to_use = pdf.pages[0]
            page_text = page_to_use.extract_text()
            if not page_text or len(page_text.strip()) < 50:
                return extract_shipper_name_ocr(pdf_path)
            return extract_from_specific_page_text(page_to_use)
    except Exception as e:
        print(f"   ❌ Text extraction error: {e}")
        return extract_shipper_name_ocr(pdf_path)
```

---

## Text Extraction Path

### `extract_shipper_name_text_based(pdf_path)`
pdfplumber — finds `shipper`/`consignee` section markers, builds list of candidate lines.

```python
def extract_shipper_name_text_based(pdf_path):
    try:
        with pdfplumber.open(pdf_path) as pdf:
            shipper_page = None
            for page_num, page in enumerate(pdf.pages):
                text = page.extract_text()
                if text and ('shipper' in text.lower() or 'consignee' in text.lower()):
                    shipper_page = page
                    break
            if not shipper_page:
                return None

            page_text = shipper_page.extract_text()
            lines = page_text.split('\n')
            shipper_start = -1
            consignee_start = -1

            for i, line in enumerate(lines):
                line_lower = line.lower().strip()
                if 'shipper' in line_lower and ('name' in line_lower or 'address' in line_lower):
                    shipper_start = i
                elif 'consignee' in line_lower and ('name' in line_lower or 'address' in line_lower):
                    consignee_start = i
                    break

            if shipper_start == -1:
                return None

            start_idx = max(0, shipper_start + 1)
            end_idx = consignee_start if consignee_start > 0 else min(len(lines), 25)
            potential_companies = []
            for i in range(start_idx, end_idx):
                if i < len(lines):
                    line = lines[i].strip()
                    if len(line) > 8:
                        cleaned_line = clean_extracted_text(line)
                        if is_airline_or_system_text(cleaned_line):
                            continue
                        if might_be_company(cleaned_line):
                            potential_companies.append(cleaned_line)

            return potential_companies if potential_companies else []
    except Exception as e:
        logger.error(f"Error extracting from text-based PDF: {e}")
        return None
```

### `extract_from_specific_page_text(page)`
pdfplumber page object — looks for `"Shipper s Name"` / `"Air Waybill"` indicator, extracts next non-empty line.

```python
def extract_from_specific_page_text(page):
    try:
        page_text = page.extract_text()
        if not page_text or len(page_text.strip()) < 50:
            return None

        lines = page_text.split('\n')
        indicators = [
            ("Shipper s Name", "Shipper's Name and Address"),
            ("QATAR AIR", "QATAR AIR"),
            ("Air Waybill", "Air Waybill")
        ]

        for short_indicator, full_indicator in indicators:
            for i, line in enumerate(lines):
                line_lower = line.lower()
                if short_indicator.lower() in line_lower or full_indicator.lower() in line_lower:
                    for j in range(i + 1, min(i + 5, len(lines))):
                        next_line = lines[j].strip()
                        if next_line and len(next_line) > 8:
                            cleaned_line = clean_extracted_text(next_line)
                            if is_airline_or_system_text(cleaned_line):
                                continue
                            if might_be_company(cleaned_line):
                                match = find_best_company_match(cleaned_line)
                                if match:
                                    return match
                    break

        # Fallback: character-level coordinate scan
        chars = page.chars
        shipper_y_start = None
        consignee_y_start = None
        for char in chars:
            text_lower = char['text'].lower()
            if 'shipper' in text_lower and char['x0'] < 300:
                shipper_y_start = char['top']
            elif 'consignee' in text_lower and char['x0'] < 300:
                consignee_y_start = char['top']
        lines_dict = {}
        for char in chars:
            y = int(char['top'])
            if y not in lines_dict:
                lines_dict[y] = []
            lines_dict[y].append(char)
        for y, chars_in_line in sorted(lines_dict.items()):
            if shipper_y_start and y < shipper_y_start + 5:
                continue
            if consignee_y_start and y > consignee_y_start - 10:
                break
            left_chars = [c for c in chars_in_line if c['x0'] < 400]
            if left_chars:
                left_chars.sort(key=lambda x: x['x0'])
                line_text = ''.join([c['text'] for c in left_chars]).strip()
                match = find_best_company_match(line_text)
                if match:
                    return match
        return None
    except Exception as e:
        print(f"   ❌ Error extracting from page: {e}")
        return None
```

### `process_extracted_text(text, is_text_based=True)`
Splits raw text, finds shipper/consignee boundaries, returns high-confidence `str` (≥0.80) or `list`.

```python
def process_extracted_text(text, is_text_based=True):
    if not text or len(text.strip()) < 10:
        return None
    lines = text.split('\n')
    shipper_section_start = -1
    consignee_section_start = -1

    for i, line in enumerate(lines):
        line_lower = line.lower()
        if ('shipper' in line_lower and ('name' in line_lower or 'address' in line_lower)) or \
           ('shipper' in line_lower and i < 10):
            shipper_section_start = i
        elif ('consignee' in line_lower and ('name' in line_lower or 'address' in line_lower)) or \
             ('consignee' in line_lower and i < 15):
            consignee_section_start = i
            break

    start_idx = max(0, shipper_section_start + 1) if shipper_section_start >= 0 else 0
    end_idx = consignee_section_start if consignee_section_start > 0 else min(len(lines), 25)

    potential_companies = []
    for i in range(start_idx, end_idx):
        if i < len(lines):
            line = lines[i].strip()
            if len(line) > 8:
                cleaned_line = clean_extracted_text(line)
                if is_airline_or_system_text(cleaned_line):
                    continue
                if might_be_company(cleaned_line):
                    potential_companies.append(cleaned_line)

    if not potential_companies:
        return None

    # High-confidence check (≥0.80) → return string directly, skip AI
    best_match = None
    best_score = 0.0
    best_candidate = None
    for candidate in potential_companies:
        for db_company in KNOWN_COMPANIES:
            ratio = SequenceMatcher(None, candidate.upper(), db_company.upper()).ratio()
            if ratio > best_score:
                best_score = ratio
                best_match = db_company
                best_candidate = candidate

    if best_score >= 0.80:
        return best_match  # str → caller skips AI

    return potential_companies  # list → caller sends to AI
```

---

## OCR Path (Image PDFs)

### `extract_shipper_name_ocr(pdf_path)`
Chains all OCR methods in order.

```python
def extract_shipper_name_ocr(pdf_path):
    result = try_ocrmypdf(pdf_path)
    if result:
        return result
    result = try_tesseract_pdftoppm(pdf_path)
    if result:
        return result
    result = try_pdftotext(pdf_path)
    return result
```

### `try_ocrmypdf(pdf_path)`

```python
def try_ocrmypdf(pdf_path):
    try:
        pdf_name = Path(pdf_path).name.lower()
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_pdf = os.path.join(temp_dir, "ocr_output.pdf")
            cmd = ["ocrmypdf", "--force-ocr", "--skip-text", str(pdf_path), temp_pdf]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=90,
                                    encoding='utf-8', errors='ignore')
            if result.returncode == 0 and os.path.exists(temp_pdf):
                if "bloc" in pdf_name:
                    cmd = ["pdftotext", "-f", "2", "-l", "2", "-layout", temp_pdf, "-"]
                else:
                    cmd = ["pdftotext", "-layout", temp_pdf, "-"]
                text_result = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                                             encoding='utf-8', errors='ignore')
                if text_result.returncode == 0:
                    result = process_extracted_text(text_result.stdout)
                    if result:
                        return result
    except Exception as e:
        print(f"   ⚠️  OCRmyPDF failed: {e}")
    return None
```

### `try_tesseract_pdftoppm(pdf_path)`

```python
def try_tesseract_pdftoppm(pdf_path):
    try:
        pdf_name = Path(pdf_path).name.lower()
        is_single_bloc = "bloc" in pdf_name
        with tempfile.TemporaryDirectory() as temp_dir:
            base_name = os.path.join(temp_dir, "page")
            cmd = ["pdftoppm", "-f", "1", "-l", "1", "-png", "-r", "300", str(pdf_path), base_name]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                                    encoding='utf-8', errors='ignore')
            if result.returncode == 0:
                png_file = f"{base_name}-1.png"
                if os.path.exists(png_file):
                    if is_single_bloc:
                        cropped_png = crop_image_bottom_left(png_file, temp_dir)
                    else:
                        cropped_png = crop_image_topleft(png_file, temp_dir)
                    cmd = ["tesseract", cropped_png, "stdout", "-l", "eng", "--psm", "6"]
                    ocr_result = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                                                encoding='utf-8', errors='ignore')
                    if ocr_result.returncode == 0:
                        result = process_extracted_text(ocr_result.stdout)
                        if result:
                            return result
    except Exception as e:
        print(f"   ⚠️  Tesseract failed: {e}")
    return None
```

### `try_pdftotext(pdf_path)`

```python
def try_pdftotext(pdf_path):
    try:
        cmd = ["pdftotext", "-layout", str(pdf_path), "-"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                                encoding='utf-8', errors='ignore')
        if result.returncode == 0 and result.stdout.strip():
            extracted_result = process_extracted_text(result.stdout)
            if extracted_result:
                return extracted_result
    except Exception as e:
        print(f"   ⚠️  pdftotext failed: {e}")
    return None
```

### `crop_image_topleft(png_file, temp_dir)`
Standard AWB — crops top-left 50% × 40%.

```python
def crop_image_topleft(png_file, temp_dir):
    try:
        from PIL import Image
        img = Image.open(png_file)
        width, height = img.size
        crop_box = (0, 0, int(width * 0.5), int(height * 0.4))
        cropped_img = img.crop(crop_box)
        cropped_file = os.path.join(temp_dir, "cropped.png")
        cropped_img.save(cropped_file)
        return cropped_file
    except Exception as e:
        print(f"   ⚠️  PIL cropping failed: {e}, using original")
        return png_file
```

### `crop_image_bottom_left(png_file, temp_dir)`
Bloc single-page PDF — crops bottom-left 60% × 50%.

```python
def crop_image_bottom_left(png_file, temp_dir):
    try:
        from PIL import Image
        img = Image.open(png_file)
        width, height = img.size
        crop_box = (0, int(height * 0.5), int(width * 0.6), height)
        cropped_img = img.crop(crop_box)
        cropped_file = os.path.join(temp_dir, "cropped_bottom_left.png")
        cropped_img.save(cropped_file)
        return cropped_file
    except Exception as e:
        print(f"   ⚠️  Bottom-left cropping failed: {e}, using original")
        return png_file
```

### `crop_image_bottom_center(png_file, temp_dir)`
Bloc multi-page PDF — crops bottom center (15%–85% width, bottom 50%).

```python
def crop_image_bottom_center(png_file, temp_dir):
    try:
        from PIL import Image
        img = Image.open(png_file)
        width, height = img.size
        crop_box = (int(width * 0.15), int(height * 0.5), int(width * 0.85), height)
        cropped_img = img.crop(crop_box)
        cropped_file = os.path.join(temp_dir, "cropped_bottom_center.png")
        cropped_img.save(cropped_file)
        return cropped_file
    except Exception as e:
        print(f"   ⚠️  Bottom-center cropping failed: {e}, using original")
        return png_file
```

---

## Text / Name Cleaning Helpers

### `clean_extracted_text(text)`
Strips system suffixes, applies OCR fix dict, regex char fixes.

```python
def clean_extracted_text(text):
    if not text or len(text) < 3:
        return text
    cleaned = ' '.join(text.split())
    system_suffixes = [
        ' Air Waybill', ' issued by', ' Issued by',
        ' +O6ISHES-6E—+F8 issued by', ' Not Negotiable'
    ]
    for suffix in system_suffixes:
        if suffix in cleaned:
            cleaned = cleaned.split(suffix)[0].strip()
    ocr_fixes = {
        'L1D': 'LTD', 'LID': 'LTD', 'C0.': 'CO.', 'CO,': 'CO.',
        'CO. .LTD': 'CO.,LTD', 'CO..LTD': 'CO.,LTD', 'CO. LTD': 'CO.,LTD',
        'LOGIST1CS': 'LOGISTICS', 'LOGIGHES': 'LOGISTICS', 'LOGISHCS': 'LOGISTICS',
        'LOGIGHCS': 'LOGISTICS', 'LOGISITICS': 'LOGISTICS',
        'INTERNAT1ONAL': 'INTERNATIONAL', 'INTERNAT1ON4L': 'INTERNATIONAL',
        'A1RWAYS': 'AIRWAYS', '1NC': 'INC', 'L1MITED': 'LIMITED',
        'COMPAN1': 'COMPANY', 'SHANGHA|': 'SHANGHAI', 'F1XLINK': 'FIXLINK',
        '+76': 'LTD', ' +76': ' LTD', 'CO +76': 'CO., LTD',
    }
    for wrong, correct in ocr_fixes.items():
        cleaned = cleaned.replace(wrong, correct)
    cleaned = re.sub(r'(?<=[A-Z])0(?=[A-Z])', 'O', cleaned)
    cleaned = re.sub(r'(?<=[A-Z])1(?=[A-Z])', 'I', cleaned)
    cleaned = re.sub(r'\|(?=[A-Z])', 'I', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned)
    cleaned = re.sub(r'[—–-]{2,}', '', cleaned)
    cleaned = re.sub(r'^[^A-Za-z0-9]+', '', cleaned)
    return cleaned.strip()
```

### `clean_company_name(name)`
Strips leading junk, trims everything after `LTD / LIMITED / INC / CORP`.

```python
def clean_company_name(name):
    if not name:
        return name
    cleaned = re.sub(r'^[^A-Za-z0-9]+', '', name)
    cleaned = re.sub(r'[^A-Za-z0-9.]+$', '', cleaned)
    company_suffixes = [
        r'LTD\.', r'LIMITED', r'LTD',
        r'INC\.', r'INC',
        r'CORP\.', r'CORP',
        r'CO\.,LTD', r'CO\.LTD',
    ]
    for suffix in company_suffixes:
        pattern = rf'({suffix})[\s\S]*$'
        match = re.search(pattern, cleaned, re.IGNORECASE)
        if match:
            cleaned = cleaned[:match.end(1)]
            break
    return cleaned.strip()
```

### `might_be_company(text)`
Returns `True` if text contains company keywords OR uppercase ratio >0.3.

```python
def might_be_company(text):
    if not text or len(text) < 8:
        return False
    text_upper = text.upper()
    company_indicators = [
        'LOGISTICS', 'INTERNATIONAL', 'CO.', 'LTD', 'INC', 'CORP',
        'EXPRESS', 'SHIPPING', 'GROUP', 'COMPANY', 'FIXLINK', 'ANPORT'
    ]
    has_indicator = any(indicator in text_upper for indicator in company_indicators)
    upper_ratio = sum(1 for c in text if c.isupper()) / len(text) if text else 0
    return has_indicator or upper_ratio > 0.3
```

### `is_airline_or_system_text(text)`
Returns `True` for known airlines, system phrases, `MED AFRICA LOGISTICS`, emails, long digit runs.

```python
def is_airline_or_system_text(text):
    if not text:
        return False
    text_upper = text.upper()
    own_companies = ['MED AFRICA LOGISTICS']
    for own_company in own_companies:
        if own_company in text_upper:
            return True
    airlines = [
        'QATAR AIRWAYS', 'CHINA EASTERN AIRLINES', 'ETIHAD AIRWAYS',
        'TURKISH AIRLINES', 'EMIRATES', 'AIR FRANCE', 'LUFTHANSA',
        'CATHAY PACIFIC', 'SINGAPORE AIRLINES', 'BRITISH AIRWAYS'
    ]
    system_text = [
        'AIR WAYBILL', 'ISSUED BY', 'NOT NEGOTIABLE', 'COPIES 1, 2',
        'TABULATOR STOPS', 'STAPLE DOCUMENTS', 'PERFORATION',
        'MEMBER OF IATA', 'P.O.BOX', 'DOHA.QATAR', 'HONG KONG',
        'VINCENT 1363', 'TEL:', 'EMAIL', '@', 'COM.CN',
        'INTERMEDIATE STOPPING', 'CARRIER DEEMS', 'CONDITIONS OF CONTRACT'
    ]
    if any(airline in text_upper for airline in airlines):
        return True
    if any(sys_text in text_upper for sys_text in system_text):
        return True
    if '@' in text or (any(c.isdigit() for c in text) and len([c for c in text if c.isdigit()]) > 8):
        return True
    return False
```

### `clean_for_matching(text)`
Removes known noise strings and OCR artefacts before fuzzy compare.

```python
def clean_for_matching(text):
    if not text:
        return ""
    cleaned = text
    removals = [
        ' Air Waybill', ' issued by', ' Issued by', ' Not Negotiable',
        '+O6ISHES-6E—+F8', 'Ge Senccaiieeiont ys', '+76', 'LOGIGHES CO', 'CO +76'
    ]
    for removal in removals:
        cleaned = cleaned.replace(removal, '')
    fixes = {
        'SHANGHA|': 'SHANGHAI', 'F1XLINK': 'FIXLINK', 'LOGIGHES': 'LOGISTICS',
        'INTERNAT1ONAL': 'INTERNATIONAL', 'L1MITED': 'LIMITED',
        'C0.': 'CO.', 'L1D': 'LTD', '1NC': 'INC',
    }
    for wrong, correct in fixes.items():
        cleaned = cleaned.replace(wrong, correct)
    cleaned = re.sub(r'[^\w\s.,()&-]', ' ', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned)
    return cleaned.strip()
```

### `extract_key_terms(company_name)`
Extracts non-generic words (not CO/LTD/INC…) for key-term matching.

```python
def extract_key_terms(company_name):
    if not company_name:
        return []
    words = company_name.upper().split()
    common_words = {'CO', 'CO.', 'LTD', 'LIMITED', 'INC', 'CORP', 'THE', 'AND', '&'}
    important_words = {'LOGISTICS', 'INTERNATIONAL', 'EXPRESS', 'SHIPPING', 'AIRWAYS'}
    key_terms = []
    for word in words:
        clean_word = word.strip('.,()&-')
        if clean_word in important_words or (len(clean_word) > 3 and clean_word not in common_words):
            key_terms.append(clean_word)
    return key_terms
```

---

## Fuzzy Matching

### `find_best_company_match(extracted_text, min_similarity=0.6)`
Iterates `KNOWN_COMPANIES`, uses `SequenceMatcher` + word overlap + key-term boosting.

```python
def find_best_company_match(extracted_text, min_similarity=0.6):
    if not extracted_text or len(extracted_text) < 5:
        return None
    cleaned_text = clean_for_matching(extracted_text)
    best_match = None
    best_score = 0
    for known_company in KNOWN_COMPANIES:
        scores = []
        score1 = difflib.SequenceMatcher(None, cleaned_text.upper(), known_company.upper()).ratio()
        scores.append(score1)
        cleaned_known = clean_for_matching(known_company)
        score2 = difflib.SequenceMatcher(None, cleaned_text.upper(), cleaned_known.upper()).ratio()
        scores.append(score2)
        text_words = set(cleaned_text.upper().split())
        known_words = set(cleaned_known.upper().split())
        if known_words:
            word_overlap = len(text_words & known_words) / len(known_words)
            scores.append(word_overlap)
        key_terms = extract_key_terms(known_company)
        text_key_terms = extract_key_terms(cleaned_text)
        if key_terms:
            key_overlap = len(set(text_key_terms) & set(key_terms)) / len(key_terms)
            scores.append(key_overlap)
        max_score = max(scores)
        if max_score > best_score and max_score >= min_similarity:
            best_score = max_score
            best_match = known_company
    return best_match if best_match else None
```

### `apply_high_threshold_fuzzy_matching(extracted_name, is_text_pdf, min_similarity=0.8)`
Wrapper — text PDFs use 0.8, image PDFs use 0.6.

```python
def apply_high_threshold_fuzzy_matching(extracted_name, is_text_pdf, min_similarity=0.8):
    if not extracted_name:
        return None
    if is_text_pdf:
        match = find_best_company_match(extracted_name, min_similarity=min_similarity)
        if match:
            return match
        else:
            add_company_to_database(extracted_name)
            return extracted_name
    else:
        match = find_best_company_match(extracted_name, min_similarity=0.6)
        return match if match else extracted_name
```

---

## Gemini AI Verification

### `setup_gemini_api()`
Reads `GEMINI_API_KEY`, creates `google.genai.Client`.

```python
def setup_gemini_api():
    global GENAI_CLIENT, GENAI_MODEL, USE_NEW_API
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        return False
    try:
        if USE_NEW_API:
            GENAI_CLIENT = genai_new.Client(api_key=api_key)
            GENAI_MODEL = (os.getenv("GEMINI_MODEL") or "").strip() or DEFAULT_GEMINI_MODEL
            return True
        else:
            logger.error("Please install: pip install google-genai")
            return False
    except Exception as e:
        logger.error(f"Error configuring Gemini API: {e}")
        return False
```

### `_gemini_response_text(response)`
Extracts `.text`, skips `thought` parts for Gemini 3 multi-part responses.

```python
def _gemini_response_text(response):
    if response is None:
        return None
    if hasattr(response, "text") and response.text:
        return response.text
    try:
        parts_out = []
        cands = getattr(response, "candidates", None) or []
        if not cands:
            return str(response)
        content = getattr(cands[0], "content", None)
        part_list = getattr(content, "parts", None) if content else None
        if not part_list:
            return str(response)
        for part in part_list:
            if getattr(part, "thought", False):
                continue
            t = getattr(part, "text", None)
            if t:
                parts_out.append(t)
        return "\n".join(parts_out) if parts_out else str(response)
    except Exception:
        return str(response)
```

### `verify_shipper_with_gemini(extracted_name, database_companies)`
Builds prompt with candidates + DB[:25], calls model with fallback list, parses JSON.

**Model fallback order:**
```
gemini-3.1-flash-lite-preview  ← default
gemini-2.5-flash
gemini-1.5-flash
```

**Returns:** `{ reasoning, matched_company, is_new_company, selected_candidate, final_name }`

```python
def verify_shipper_with_gemini(extracted_name, database_companies):
    global GENAI_CLIENT, GENAI_MODEL, USE_NEW_API
    try:
        candidates = extracted_name if isinstance(extracted_name, list) else [extracted_name]
        prompt = f"""
You are an expert in logistics company name identification and OCR error correction.
Here are all potential company names extracted from a shipping document (prioritized by fuzzy matching):
{json.dumps(candidates, indent=2)}

KNOWN COMPANIES DATABASE:
{json.dumps(database_companies[:25], indent=2)}

CRITICAL INSTRUCTIONS:
1. OCR ERROR CORRECTION: Fix "LOGIGHES"→"LOGISTICS", "+76"→"LTD", "C0"→"CO", etc.
   Remove leading non-letter characters: "; COMPANY" → "COMPANY"
2. Accept ALL company types (TRADING, LOGISTICS, MANUFACTURING, etc.)
3. Fuzzy match candidates against DB (>70% similarity = match). Candidates at START of list are pre-ranked.
4. NEVER select "MED AFRICA LOGISTICS" (consignee, not shipper).
5. If candidate contains company name + address, extract ONLY the company name.

OUTPUT FORMAT (exact JSON):
{{
    "reasoning": "step-by-step analysis",
    "matched_company": "best database match or null",
    "is_new_company": true/false,
    "selected_candidate": "chosen candidate from list",
    "final_name": "final cleaned company name"
}}
"""
        if not (USE_NEW_API and GENAI_CLIENT):
            raise Exception("Google Gemini API not available.")

        seen = set()
        model_names = []
        for m in (GENAI_MODEL,) + GEMINI_MODEL_FALLBACKS:
            if m and m not in seen:
                seen.add(m)
                model_names.append(m)

        response = None
        last_error = None
        for model_name in model_names:
            try:
                response = GENAI_CLIENT.models.generate_content(
                    model=model_name, contents=prompt
                )
                break
            except Exception as e:
                last_error = e
                continue

        if response is None:
            raise Exception(f"All models failed: {last_error}")

        response_text_raw = _gemini_response_text(response)

        # Parse JSON (handle ```json fences)
        response_text = response_text_raw.strip()
        if response_text.startswith('```'):
            start = response_text.find('{')
            end = response_text.rfind('}') + 1
            json_text = response_text[start:end] if start != -1 else response_text
        else:
            json_text = response_text

        return json.loads(json_text)

    except Exception as e:
        logger.error(f"Error calling Gemini API: {e}")
        return {
            "reasoning": f"API error: {e}",
            "matched_company": None,
            "is_new_company": True,
            "selected_candidate": candidates[0] if candidates else None,
            "final_name": candidates[0] if candidates else None
        }
```

---

## Database Helpers

### `load_companies_database()`

```python
def load_companies_database():
    global KNOWN_COMPANIES
    try:
        if os.path.exists(DATABASE_FILE):
            with open(DATABASE_FILE, 'r', encoding='utf-8') as f:
                KNOWN_COMPANIES = json.load(f)
        else:
            KNOWN_COMPANIES = []
    except Exception as e:
        logger.error(f"Error loading companies database: {e}")
        KNOWN_COMPANIES = []
```

### `save_companies_database()`
Atomic write (temp file + rename) to `known_companies.json`.

```python
def save_companies_database():
    try:
        temp_file = DATABASE_FILE + '.tmp'
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(KNOWN_COMPANIES, f, indent=2, ensure_ascii=False)
        if os.path.exists(DATABASE_FILE):
            os.replace(temp_file, DATABASE_FILE)
        else:
            os.rename(temp_file, DATABASE_FILE)
    except Exception as e:
        logger.error(f"Error saving companies database: {e}")
        try:
            if os.path.exists(DATABASE_FILE + '.tmp'):
                os.remove(DATABASE_FILE + '.tmp')
        except:
            pass
```

### `add_company_to_database(company_name)`
Reloads DB first (multi-instance safety), case-insensitive dedup, then saves.

```python
def add_company_to_database(company_name):
    global KNOWN_COMPANIES
    if not company_name:
        return False
    # Reload from file to avoid overwriting concurrent writes
    try:
        if os.path.exists(DATABASE_FILE):
            with open(DATABASE_FILE, 'r', encoding='utf-8') as f:
                KNOWN_COMPANIES = json.load(f)
    except Exception as e:
        logger.warning(f"Could not reload database before adding: {e}")

    company_name_upper = company_name.upper().strip()
    existing_upper = [c.upper().strip() if c else '' for c in KNOWN_COMPANIES]
    if company_name_upper in existing_upper:
        return False

    KNOWN_COMPANIES.append(company_name)
    save_companies_database()
    return True
```

---

## Final Output

### `create_bloc_note(directory_name, mawb_number, shipper_name)`
Writes two files to the working directory.

| File | Content |
|---|---|
| `<directory_name>.txt` | 6-line bloc note: name / MAWB (no dashes) / MAWB/1 / empty / shipper / empty |
| `<directory_name>_shipper_name.txt` | Shipper name only — consumed by automation (BADR app) |

```python
def create_bloc_note(directory_name, mawb_number, shipper_name):
    bloc_note_path = os.path.join(os.getcwd(), f"{directory_name}.txt")
    mawb_clean = mawb_number.replace('-', '')
    try:
        with open(bloc_note_path, 'w', encoding='utf-8') as f:
            f.write("-------------\n")
            f.write(f"{directory_name}\n")
            f.write(f"{mawb_clean}\n")
            f.write(f"{mawb_number}/1\n")
            f.write("\n")
            f.write(f"{shipper_name}\n" if shipper_name else "\n")
            f.write("\n")

        safe_name = directory_name.replace(' ', '_')
        shipper_only_path = os.path.join(os.getcwd(), f"{safe_name}_shipper_name.txt")
        with open(shipper_only_path, 'w', encoding='utf-8') as f:
            f.write(f"{shipper_name}\n" if shipper_name else "\n")

        return True
    except Exception as e:
        print(f"    ✗ Error creating bloc note: {e}")
        return False
```

---

## What You Export for the JS App

| Asset | Value |
|---|---|
| `known_companies.json` | Plain JSON array — import directly |
| Gemini API key | `GEMINI_API_KEY` env var → `process.env.GEMINI_API_KEY` |
| Gemini model | `"gemini-3.1-flash-lite-preview"` |
| Gemini JS SDK | `npm install @google/genai` |

> The prompt string inside `verify_shipper_with_gemini` can be copy-pasted verbatim — it has no Python-specific dependencies.
