from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as E
ROOT=Path(__file__).parent
SRC=ROOT/'mori-screen-spec-unfixed.docx'
OUT=ROOT.parent/'mori-screen-spec-v0.3.docx'
N={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
def q(name): return '{'+N['w']+'}'+name
def child(parent,name):
 e=parent.find(q(name))
 if e is None: e=E.SubElement(parent,q(name))
 return e
with ZipFile(SRC) as z: files={n:z.read(n) for n in z.namelist()}
for name in ['word/document.xml','word/styles.xml','word/header1.xml','word/footer1.xml']:
 root=E.fromstring(files[name])
 # Make Korean and Latin font mapping explicit rather than letting theme fonts win.
 for f in root.findall('.//w:rFonts',N):
  f.attrib.clear()
  for a in ['ascii','hAnsi','eastAsia','cs']:f.set(q(a),'Malgun Gothic')
 for lang in root.findall('.//w:lang',N):lang.set(q('eastAsia'),'ko-KR')
 # Automatic line height prevents Word clipping larger headings to the body line box.
 for sp in root.findall('.//w:spacing',N):
  if sp.get(q('line')) is not None:
   if sp.get(q('line'))=='20': continue # invisible page-break / anchor paragraph
   sp.set(q('lineRule'),'atLeast')
 for pp in root.findall('.//w:pPr',N):child(pp,'snapToGrid').set(q('val'),'0')
 for grid in root.findall('.//w:docGrid',N):grid.getparent().remove(grid)
 if name=='word/styles.xml':
  for st in root.findall('w:style',N):
   if st.get(q('styleId')) in ['Title','Subtitle','Heading1','Heading2','Heading3','Normal']:
    rp=child(st,'rPr');f=child(rp,'rFonts');f.attrib.clear()
    for a in ['ascii','hAnsi','eastAsia','cs']: f.set(q(a),'Malgun Gothic')
    lang=child(rp,'lang');lang.set(q('val'),'ko-KR');lang.set(q('eastAsia'),'ko-KR')
    pp=child(st,'pPr');child(pp,'snapToGrid').set(q('val'),'0');sp=child(pp,'spacing')
    if st.get(q('styleId'))=='Normal':sp.set(q('line'),'300');sp.set(q('lineRule'),'atLeast')
    else:sp.set(q('line'),'264');sp.set(q('lineRule'),'auto')
 if name=='word/document.xml':
  # Use a real paragraph page break instead of inheriting the tiny break paragraph metrics.
  ps=list(root.findall('w:body/w:p',N))
  for i,pp in enumerate(ps[:-1]):
   if pp.find('.//w:br[@w:type="page"]',N) is not None and not ''.join(pp.itertext()).strip():
    nxt=ps[i+1];child(child(nxt,'pPr'),'pageBreakBefore')
    pp.getparent().remove(pp)
  # Force explicit fonts on the title/headings as well as inherited styles.
  for pp in root.findall('.//w:p',N):
   style=pp.find('w:pPr/w:pStyle',N)
   if style is not None and style.get(q('val')) in ['Title','Subtitle','Heading1','Heading2','Heading3']:
    sp=child(child(pp,'pPr'),'spacing');sp.set(q('line'),'264');sp.set(q('lineRule'),'auto')
    for r in pp.findall('w:r',N):
     rf=child(child(r,'rPr'),'rFonts');rf.attrib.clear()
     for a in ['ascii','hAnsi','eastAsia','cs']:rf.set(q(a),'Malgun Gothic')
 for t in root.findall('.//w:t',N):
  if t.text:t.text=t.text.replace('v0.1','v0.3')
 files[name]=E.tostring(root,xml_declaration=True,encoding='UTF-8',standalone=True)
settings=E.fromstring(files['word/settings.xml'])
compat=child(settings,'compat')
for item in compat.findall('w:compatSetting',N):
 if item.get(q('name'))=='compatibilityMode':item.set(q('val'),'15')
files['word/settings.xml']=E.tostring(settings,xml_declaration=True,encoding='UTF-8',standalone=True)
# The template also has an East Asian theme-font map. Keep it consistent in Word.
th=E.fromstring(files['word/theme/theme1.xml'])
for f in th.findall('.//a:font[@script="Hang"]',N):f.set('typeface','Malgun Gothic')
files['word/theme/theme1.xml']=E.tostring(th,xml_declaration=True,encoding='UTF-8',standalone=True)
with ZipFile(OUT,'w',ZIP_DEFLATED) as z:
 for name,data in files.items():z.writestr(name,data)
print(OUT)
