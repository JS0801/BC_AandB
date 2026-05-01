/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * Client script attached to the Task record by bc_vr_pdf_gen_ue.js
 * (beforeLoad). Provides the global functions invoked by the Preview
 * and Regenerate buttons, with a polished overlay UX:
 *   confirm  -> loading spinner -> success/error -> auto-reload.
 */
define(['N/https'], (https) => {

    /* ---- Overlay: show / update / hide ---- */

    const showOverlay = (message, type) => {
        hideOverlay();

        const overlay = document.createElement('div');
        overlay.id = 'bc-vr-loader';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center';

        const box = document.createElement('div');
        box.id = 'bc-vr-box';
        box.style.cssText = 'background:#fff;padding:30px 50px;border-radius:8px;text-align:center;font-family:Arial,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.3);max-width:400px';

        if (!document.getElementById('bc-vr-style')) {
            const style = document.createElement('style');
            style.id = 'bc-vr-style';
            style.textContent =
                '@keyframes bc-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}' +
                '.bc-vr-btn{padding:8px 24px;border:none;border-radius:4px;font-size:14px;cursor:pointer;margin:0 6px}' +
                '.bc-vr-btn-primary{background:#0073ea;color:#fff}.bc-vr-btn-primary:hover{background:#005bb5}' +
                '.bc-vr-btn-cancel{background:#e0e0e0;color:#333}.bc-vr-btn-cancel:hover{background:#ccc}';
            document.head.appendChild(style);
        }

        if (type === 'loading') {
            box.innerHTML =
                '<div style="margin-bottom:15px">' +
                '<div style="border:4px solid #f3f3f3;border-top:4px solid #0073ea;border-radius:50%;width:40px;height:40px;animation:bc-spin 1s linear infinite;margin:0 auto"></div>' +
                '</div>' +
                '<div style="font-size:14px;color:#333">' + message + '</div>';
        } else if (type === 'success') {
            box.innerHTML =
                '<div style="margin-bottom:12px">' +
                '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="margin:0 auto;display:block"><circle cx="12" cy="12" r="11" fill="#4CAF50"/><path d="M7 12.5l3 3 7-7" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                '</div>' +
                '<div style="font-size:16px;font-weight:600;color:#333;margin-bottom:6px">Success</div>' +
                '<div style="font-size:14px;color:#555;margin-bottom:18px">' + message + '</div>' +
                '<div style="font-size:12px;color:#999">Reloading…</div>';
        } else if (type === 'error') {
            box.innerHTML =
                '<div style="margin-bottom:12px">' +
                '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="margin:0 auto;display:block"><circle cx="12" cy="12" r="11" fill="#F44336"/><path d="M8 8l8 8M16 8l-8 8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>' +
                '</div>' +
                '<div style="font-size:16px;font-weight:600;color:#333;margin-bottom:6px">Error</div>' +
                '<div style="font-size:14px;color:#555;margin-bottom:18px">' + message + '</div>' +
                '<button class="bc-vr-btn bc-vr-btn-cancel" onclick="document.getElementById(\'bc-vr-loader\').remove()">Close</button>';
        } else if (type === 'confirm') {
            box.innerHTML =
                '<div style="margin-bottom:12px">' +
                '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="margin:0 auto;display:block"><circle cx="12" cy="12" r="11" fill="#FF9800"/><text x="12" y="17" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold">?</text></svg>' +
                '</div>' +
                '<div style="font-size:16px;font-weight:600;color:#333;margin-bottom:6px">Confirm</div>' +
                '<div style="font-size:14px;color:#555;margin-bottom:18px">' + message + '</div>' +
                '<div>' +
                '<button id="bc-vr-confirm-yes" class="bc-vr-btn bc-vr-btn-primary">Yes, Regenerate</button>' +
                '<button id="bc-vr-confirm-no" class="bc-vr-btn bc-vr-btn-cancel">Cancel</button>' +
                '</div>';
        }

        overlay.appendChild(box);
        document.body.appendChild(overlay);
    };

    const hideOverlay = () => {
        const el = document.getElementById('bc-vr-loader');
        if (el) el.remove();
    };

    /* ---- Preview ---- */
    const bcVrPreview = (suiteletUrl) => {
        window.open(suiteletUrl, '_blank');
    };

    /* ---- Regenerate ---- */
    const bcVrRegenerate = (suiteletUrl) => {
        // Show confirm overlay
        showOverlay(
            'Regenerate the Valve Repair PDFs? Existing PDF attachments on this Task will be replaced.',
            'confirm'
        );

        document.getElementById('bc-vr-confirm-no').onclick = () => { hideOverlay(); };
        document.getElementById('bc-vr-confirm-yes').onclick = () => {
            // Switch to loading state
            showOverlay('Generating Valve Repair PDFs… Please wait.', 'loading');

            https.get.promise({ url: suiteletUrl }).then((response) => {
                try {
                    var result = JSON.parse(response.body);
                    if (result.success) {
                        showOverlay(result.message || 'PDF regenerated successfully.', 'success');
                        setTimeout(() => { window.location.reload(); }, 1500);
                    } else {
                        showOverlay(result.message || 'Unknown error occurred.', 'error');
                    }
                } catch (e) {
                    showOverlay('Unexpected response from server.', 'error');
                }
            }).catch((e) => {
                showOverlay('Error: ' + e.message, 'error');
            });
        };
    };

    const pageInit = () => {
    };

    return { pageInit, bcVrPreview, bcVrRegenerate };
});