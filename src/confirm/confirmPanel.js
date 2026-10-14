// homepage-confirm script: separate file, page CSP refuses inline script; see appProtocol.ts
// request id via data attribute, never parsed as code

(function () {
    const dialog = document.querySelector('.dialog');
    const requestId = dialog ? dialog.getAttribute('data-request-id') : null;

    let submitted = false;

    function submit(result) {
        if (submitted || !requestId) return;
        submitted = true;
        window.homepageConfirmAPI.submit(requestId, result);
    }

    requestAnimationFrame(() => {
        document.body.classList.add('visible');
    });

    document.getElementById('cancelBtn').addEventListener('click', () => submit(false));
    document.getElementById('confirmBtn').addEventListener('click', () => submit(true));

    document.body.addEventListener('click', (event) => {
        if (event.target === document.body) submit(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') submit(false);
        if (event.key === 'Enter') submit(true);
    });
})();
