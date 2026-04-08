/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/https'], (https) => {

    const showLoader = (message) => {
        hideLoader();
        const overlay = document.createElement('div');
        overlay.id = 'bc-psv-loader';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;padding:30px 50px;border-radius:8px;text-align:center;font-family:Arial,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.3)';
        box.innerHTML =
            '<div style="margin-bottom:15px">' +
            '<div style="border:4px solid #f3f3f3;border-top:4px solid #0073ea;border-radius:50%;width:40px;height:40px;animation:bc-spin 1s linear infinite;margin:0 auto"></div>' +
            '</div>' +
            '<div style="font-size:14px;color:#333">' + message + '</div>';
        if (!document.getElementById('bc-psv-spinner-style')) {
            const style = document.createElement('style');
            style.id = 'bc-psv-spinner-style';
            style.textContent = '@keyframes bc-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}';
            document.head.appendChild(style);
        }
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    };

    const hideLoader = () => {
        const el = document.getElementById('bc-psv-loader');
        if (el) el.remove();
    };

    const bcPsvPreview = (suiteletUrl) => {
        window.open(suiteletUrl, '_blank');
    };

    const bcPsvRegenerate = (suiteletUrl) => {
        if (!confirm('Regenerate the PSV PDF? This will create a new version.')) return;
        showLoader('Generating PSV PDF… Please wait.');
        https.get.promise({ url: suiteletUrl }).then((response) => {
            hideLoader();
            try {
                var result = JSON.parse(response.body);
                if (result.success) {
                    alert('PDF regenerated successfully.');
                    window.location.reload();
                } else {
                    alert('Error: ' + (result.message || 'Unknown error'));
                }
            } catch (e) {
                alert('Unexpected response from server.');
            }
        }).catch((e) => {
            hideLoader();
            alert('Error: ' + e.message);
        });
    };

    const pageInit = () => {
    };

    return { pageInit, bcPsvPreview, bcPsvRegenerate };
});
