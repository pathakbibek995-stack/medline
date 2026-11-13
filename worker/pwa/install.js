const installButton = document.querySelector('#install-app');
const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = installed();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installButton.hidden = true;
});
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !installed()) installButton.hidden = false;

installButton.addEventListener('click', async () => {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    installButton.hidden = true;
    await prompt.prompt();
    await prompt.userChoice;
  } else if (isIOS) {
    const dialog = document.querySelector('#install-help');
    if (!dialog.open) dialog.showModal();
  }
});
document.querySelector('#close-install-help').addEventListener('click', () => {
  document.querySelector('#install-help').close();
});
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'})
    .catch(error => console.warn('App installation setup unavailable:', error.message));
}
