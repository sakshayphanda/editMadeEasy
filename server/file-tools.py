"""Bounded PDF, image, font and archive operations. Receives only server-created paths."""
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import zipfile

MAX_BYTES = 200 * 1024 * 1024
MAX_FILES = 1000

def safe_name(name):
    name = name.replace('\\', '/')
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or ':' in name or not path.name:
        raise ValueError('Archive contains unsafe paths.')
    return str(path)

def repack(files, output, fmt, directory=False):
    entries = []
    opened = []
    try:
        if directory:
            root = Path(files[0])
            for path in root.rglob('*'):
                if path.is_symlink():
                    raise ValueError('Archive contains links.')
                if path.is_file():
                    entries.append((safe_name(str(path.relative_to(root))), path.stat().st_size, path))
        elif zipfile.is_zipfile(files[0]):
            source = zipfile.ZipFile(files[0]); opened.append(source)
            for entry in source.infolist():
                if entry.is_dir(): continue
                if entry.flag_bits & 1 or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Encrypted archives and links are not supported.')
                entries.append((safe_name(entry.filename), entry.file_size, lambda e=entry: source.open(e)))
        else:
            source = tarfile.open(files[0], 'r:*'); opened.append(source)
            for entry in source:
                if entry.isdir(): continue
                if not entry.isfile(): raise ValueError('Archive contains links or special files.')
                entries.append((safe_name(entry.name), entry.size, lambda e=entry: source.extractfile(e)))
                if len(entries) > MAX_FILES: raise ValueError('Archive has too many files.')
        if len(entries) > MAX_FILES or sum(e[1] for e in entries) > MAX_BYTES:
            raise ValueError('Archive exceeds the 200 MB / 1,000 file limit.')
        if not entries: raise ValueError('Archive has no files.')
        if len(set(e[0] for e in entries)) != len(entries): raise ValueError('Archive contains duplicate paths.')
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) if fmt == 'zip' else tarfile.open(output, 'w') as target:
            for name, size, reader in entries:
                with reader.open('rb') if isinstance(reader, Path) else reader() as stream:
                    data = stream.read(min(size + 1, MAX_BYTES + 1))
                if len(data) != size: raise ValueError('Archive entry has an invalid size.')
                if fmt == 'zip': target.writestr(name, data)
                else:
                    info = tarfile.TarInfo(name); info.size = len(data)
                    target.addfile(info, io.BytesIO(data))
    finally:
        for source in opened: source.close()

def page_indices(value, count):
    if not value.strip(): return list(range(count))
    result = []
    for part in value.split(','):
        bounds = part.strip().split('-')
        if len(bounds) > 2 or not all(v.isdigit() for v in bounds): raise ValueError('Choose pages such as 1-3,5.')
        first, last = int(bounds[0]), int(bounds[-1])
        if first < 1 or last < first or last > count: raise ValueError('Choose page numbers within the PDF.')
        result.extend(range(first-1,last))
        if len(result) > 500: raise ValueError('PDF selection exceeds 500 pages.')
    return list(dict.fromkeys(result))

def pdf_tool(id, files, settings, output):
    import fitz
    from pypdf import PdfReader, PdfWriter
    password = settings.get('password', '')
    if id in ['jpg-to-pdf', 'png-to-pdf']:
        from PIL import Image, ImageOps
        images = []
        try:
            for file in files:
                with Image.open(file) as image:
                    image = ImageOps.exif_transpose(image).convert('RGB')
                    if image.width * image.height > 40_000_000: raise ValueError('Choose images under 40 megapixels.')
                    images.append(image)
            images[0].save(output, 'PDF', save_all=True, append_images=images[1:])
        finally:
            for image in images: image.close()
        return
    if id in ['split','merge','unlock','protect','rotate']:
        writer = PdfWriter()
        total = 0
        for file in files:
            reader = PdfReader(file)
            if reader.is_encrypted and not reader.decrypt(password): raise ValueError('PDF password is incorrect or required.')
            total += len(reader.pages)
            if total > 500: raise ValueError('PDF operations support up to 500 pages.')
            selected = page_indices(settings.get('pages',''),len(reader.pages))
            for index,page in enumerate(reader.pages):
                if id == 'split' and index not in selected: continue
                if id == 'rotate' and index in selected: page.rotate(int(settings['rotation']))
                writer.add_page(page)
        if id == 'protect':
            if not password: raise ValueError('Enter a password for the PDF.')
            writer.encrypt(password, algorithm='AES-256')
        with open(output,'wb') as stream: writer.write(stream)
        return
    with fitz.open(files[0]) as document:
        if document.needs_pass and not document.authenticate(password): raise ValueError('PDF is encrypted. Unlock it first.')
        if len(document) > 500: raise ValueError('PDF operations support up to 500 pages.')
        if id == 'compress':
            document.save(output, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True)
        elif id == 'page-numbers':
            for i,page in enumerate(document):
                box=page.rect
                page.insert_textbox(fitz.Rect(0,box.height-28,box.width,box.height-8),str(i+1),fontsize=10,align=1,color=(0,0,0))
            document.save(output,garbage=4,deflate=True)
        elif id in ['to-jpg','to-png']:
            if len(document)>100: raise ValueError('PDF image export supports up to 100 pages.')
            fmt = 'jpg' if id=='to-jpg' else 'png'
            total=0
            with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
                for i,page in enumerate(document):
                    if page.rect.width*page.rect.height*4>40_000_000: raise ValueError('PDF page dimensions exceed the image export limit.')
                    data=page.get_pixmap(matrix=fitz.Matrix(2,2),alpha=False).tobytes(fmt)
                    total+=len(data)
                    if total>MAX_BYTES: raise ValueError('PDF image export exceeds 200 MB.')
                    archive.writestr(f'page-{i+1}.{fmt}',data)
        elif id == 'to-html':
            with open(output,'w',encoding='utf8') as stream:
                stream.write('<!doctype html><html><head><meta charset="utf-8"><title>Converted PDF</title></head><body>')
                for page in document: stream.write(page.get_text('html'))
                stream.write('</body></html>')
        elif id == 'to-word':
            from docx import Document
            result=Document()
            has_text=False
            for i,page in enumerate(document):
                if i: result.add_page_break()
                for line in page.get_text(sort=True).splitlines():
                    result.add_paragraph(line)
                    has_text=has_text or bool(line.strip())
            if not has_text: raise ValueError('Scanned PDFs require OCR before conversion to editable text.')
            result.save(output)
        elif id == 'to-excel':
            from openpyxl import Workbook
            result=Workbook();result.remove(result.active)
            for index,page in enumerate(document):
                tables=page.find_tables().tables
                for n,table in enumerate(tables):
                    sheet=result.create_sheet(f'Page {index+1} Table {n+1}')
                    for row in table.extract():
                        # Keep untrusted extracted strings as data, never Excel formulas.
                        sheet.append([("'"+cell if isinstance(cell,str) and cell.startswith(('=','+','-','@')) else cell) for cell in row])
            if not result.sheetnames: raise ValueError('No tables were detected. Scans require OCR first.')
            result.save(output)
        else: raise ValueError('Unknown PDF operation.')

def main(job):
    group,id,files,settings,output = (job[key] for key in ['group','id','files','settings','output'])
    fmt=settings['format']
    if group=='pdf': pdf_tool(id,files,settings,output)
    elif id=='image':
        from PIL import Image, ImageOps
        Image.MAX_IMAGE_PIXELS=40_000_000
        with Image.open(files[0]) as source:
            image=ImageOps.exif_transpose(source)
            if image.width*image.height>40_000_000: raise ValueError('Choose an image under 40 megapixels.')
            if fmt in ['jpg','bmp']:
                rgba=image.convert('RGBA');background=Image.new('RGB',image.size,'white');background.paste(rgba,mask=rgba.getchannel('A'));image=background
            elif fmt=='gif': image=image.convert('RGBA')
            image.save(output,format={'jpg':'JPEG','tiff':'TIFF'}.get(fmt,fmt.upper()))
    elif id=='font':
        from fontTools.ttLib import TTFont
        font=TTFont(files[0])
        if fmt=='native':
            fmt='otf' if font.sfntVersion=='OTTO' else 'ttf'
            output=str(Path(output).with_suffix('.'+fmt));font.flavor=None
        else: font.flavor=fmt
        font.save(output);font.close()
    elif id in ['archive','pack-directory']:
        repack(files,output,fmt,id=='pack-directory')
    else: raise ValueError('Unknown file operation.')
    print(json.dumps({'path':output,'format':fmt}))

if __name__=='__main__':
    try:
        main(json.loads(Path(sys.argv[1]).read_text()))
    except Exception as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
