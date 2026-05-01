/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * Client script attached to the Task record by bc_vr_pdf_gen_ue.js
 * (beforeLoad). Provides the global functions invoked by the Preview
 * and Regenerate buttons.
 */
define([], function () {

    /**
     * Open the merged VR PDF in a new browser tab/window.
     * Suitelet streams the file inline via response.writeFile.
     */
    window.bcVrPreview = function (suiteletUrl) {
        if (!suiteletUrl) return;
        window.open(suiteletUrl, '_blank');
    };

    /**
     * Confirm with the user, then navigate to the regenerate Suitelet.
     * The Suitelet re-runs the full PDF pipeline and redirects back
     * to the Task record on completion.
     */
    window.bcVrRegenerate = function (suiteletUrl) {
        if (!suiteletUrl) return;

        var confirmed = window.confirm(
            'Regenerate the Valve Repair PDFs for this Task?\n\n' +
            'Existing PDF attachments on the Task will be detached ' +
            'and replaced with newly generated files.'
        );
        if (!confirmed) return;

        // Visual cue while NetSuite processes the request
        document.body.style.cursor = 'wait';

        // Same-tab navigation; Suitelet ends with a redirect back to the Task.
        window.location.href = suiteletUrl;
    };

    // SuiteScript 2.x ClientScript needs at least one entry point exported
    // even when all logic is in beforeLoad-injected globals.
    function pageInit() { /* no-op */ }

    return { pageInit: pageInit };
});
