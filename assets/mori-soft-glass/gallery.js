const motionSwitch = document.getElementById('motion');
const backdropSwitch = document.getElementById('backdrop');
const systemMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function showMotion() {
  document.querySelectorAll('img[data-animation]').forEach((image) => {
    image.src = motionSwitch.checked ? image.dataset.animation : image.dataset.poster;
  });
}

function followSystemMotion() {
  motionSwitch.checked = !systemMotion.matches;
  showMotion();
}

motionSwitch.addEventListener('change', showMotion);
backdropSwitch.addEventListener('change', () => {
  document.body.classList.toggle('dark-stage', backdropSwitch.checked);
});
systemMotion.addEventListener('change', followSystemMotion);
followSystemMotion();
