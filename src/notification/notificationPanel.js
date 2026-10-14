// toast script: separate file, page CSP refuses inline script; see appProtocol.ts

setTimeout(() => {
    document.body.style.opacity = '1';
}, 100);

setTimeout(() => {
    document.body.classList.add('fade-out');
    document.body.style.opacity = '0';
    setTimeout(() => {
        window.notificationAPI.done();
    }, 300);
}, 4500);
