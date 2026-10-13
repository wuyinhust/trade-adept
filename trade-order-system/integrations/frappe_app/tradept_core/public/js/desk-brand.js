/* Tradept visual identity. Never rewrite documents, app IDs or legal notices. */
(() => {
    const base = '/assets/tradept_core/';
    function apply() {
        const home = document.querySelector('.navbar-home');
        if (home) {
            home.setAttribute('aria-label', 'Tradept');
            home.setAttribute('title', 'Tradept');
            const logo = home.querySelector('img');
            if (logo && logo.getAttribute('src') !== base + 'images/tradept-logo.png') {
                logo.src = base + 'images/tradept-logo.png';
                logo.alt = 'Tradept';
                logo.classList.add('tradept-desk-logo');
            }
        }
        const title = document.title.replace(/(?:\s*[-|·]\s*)?(ERPNext|Frappe)\s*$/, ' · Tradept');
        if (title !== document.title) document.title = title.replace(/^ · /, '');
        if (!document.getElementById('tradept-legal-link')) {
            const link = document.createElement('a');
            link.id = 'tradept-legal-link';
            link.href = '/tradept-licenses';
            link.textContent = 'Tradept · 开源许可与来源';
            document.body.appendChild(link);
        }
    }
    function start() {
        apply();
        let pending = false;
        const observer = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; apply(); });
        });
        // Watch element insertion only, not attribute writes performed by apply.
        observer.observe(document.body, { childList: true, subtree: true });
        const title = document.querySelector('title');
        if (title) observer.observe(title, { childList: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
