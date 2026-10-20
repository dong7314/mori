// Scale the frames, keeping each embedded app's real responsive viewport intact.
const host = document.querySelector('.device-preview');
const stage = document.querySelector('.preview-stage');
const actual = document.querySelector('#preview-actual');
let mode = 'both', actualSize = false;
function fit() {
  const toolbarBottom = document.querySelector('.preview-instructions').getBoundingClientRect().bottom;
  const availableHeight = Math.max(240, innerHeight - toolbarBottom - 80);
  const availableWidth = Math.max(220, stage.clientWidth - 8);
  const width = mode === 'both' ? 1158 : mode === 'mobile' ? 390 : 768;
  const height = mode === 'mobile' ? 844 : 1024;
  const scale = actualSize ? 1 : Math.min(1, (availableWidth - (mode === 'both' ? 40 : 0)) / width, availableHeight / height);
  host.style.setProperty('--preview-scale', String(Math.max(.2, scale)));
}
for (const button of document.querySelectorAll('button[data-preview-mode]')) button.addEventListener('click', () => {
  mode = button.dataset.previewMode;
  host.dataset.previewMode = mode;
  document.querySelectorAll('button[data-preview-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  fit();
});
actual.addEventListener('click', () => {
  actualSize = !actualSize;
  actual.setAttribute('aria-pressed', String(actualSize));
  actual.textContent = actualSize ? '화면에 맞추기' : '100% 크기';
  fit();
});
new ResizeObserver(fit).observe(stage);
addEventListener('resize', fit);
fit();
