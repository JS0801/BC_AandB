/**
* @NApiVersion 2.1
* @NScriptType UserEventScript
* @NModuleScope SameAccount
*/
define([
  'N/record',
  'N/render',
  'N/search',
  'N/file',
  'N/log',
  'N/format',
  'N/url'
], (record, render, search, file, log, format, url) => {

  /* ------------------------------------------------------------------ */
  /*  CONSTANTS – update these after confirming IDs in your account     */
  /* ------------------------------------------------------------------ */
  const PSV_RECORD_TYPE   = 'customrecord_bc_psv';   // PSV Test custom record type ID
  const TEMPLATE_ID       = 'CUSTTMPL_118_11915859_SB1_110'; // Advanced PDF template script ID
  const ROOT_FOLDER_NAME  = 'PSV Reports';
  const TASK_STATUS_CLOSED = 'COMPLETE'; // NetSuite internal value for Task "Completed/Closed"
  const SUITELET_SCRIPT   = 'customscript_bc_sl_psv_pdf_helper';
  const SUITELET_DEPLOY   = 'customdeploy_bc_sl_psv_pdf_helper';

  /* ------------------------------------------------------------------ */
  /*  beforeLoad – Add Preview & Regenerate buttons (VIEW mode only)    */
  /* ------------------------------------------------------------------ */
  const beforeLoad = (context) => {
    if (context.type !== context.UserEventType.VIEW) return;

    const taskRec = context.newRecord;
    const taskId  = taskRec.id;
    const fileId  = taskRec.getValue({ fieldId: 'custevent_bc_psv_pdf' });

    const suiteletUrl = url.resolveScript({
      scriptId: SUITELET_SCRIPT,
      deploymentId: SUITELET_DEPLOY,
      params: { taskId: taskId }
    });

    // Preview – only if PDF exists
    if (fileId) {
      const previewUrl = suiteletUrl + '&action=preview';
      context.form.addButton({
        id: 'custpage_btn_preview_pdf',
        label: 'Preview PSV PDF',
        functionName: "bcPsvPreview('" + previewUrl + "')"
      });
    }

    // Regenerate – always available
    const regenUrl = suiteletUrl + '&action=regenerate';
    context.form.addButton({
      id: 'custpage_btn_regen_pdf',
      label: 'Regenerate PSV PDF',
      functionName: "bcPsvRegenerate('" + regenUrl + "')"
    });

    // Attach client script for loader + button handlers
    context.form.clientScriptModulePath = './bc_psv_pdf_cs.js';
  };

  /* ------------------------------------------------------------------ */
  /*  afterSubmit                                                       */
  /* ------------------------------------------------------------------ */
  const afterSubmit = (context) => {
    if (context.type !== context.UserEventType.CREATE &&
      context.type !== context.UserEventType.EDIT) {
        return;
      }

      const taskRec = context.newRecord;
      const newStatus = taskRec.getValue({ fieldId: 'status' });

      if (newStatus !== 'COMPLETE') return;

      if (context.type === context.UserEventType.EDIT) {
        const oldRec = context.oldRecord;
        const oldStatus = oldRec.getValue({ fieldId: 'status' });
        //if (oldStatus === 'COMPLETE') return; // was already closed, skip
      } else if (context.type !== context.UserEventType.CREATE) {
        return;
      }

      const taskId    = taskRec.id;
      const taskTitle = taskRec.getValue({ fieldId: 'title' }) || 'Untitled';

      try {
        // 3. Search for linked PSV Test record
        const psvId = findPsvTestByTask(taskId);
        if (!psvId) {

          record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_psv_error_log: `No PSV Test record linked to Task ${taskId}.`
          }
        });
          
          log.error('PSV PDF', `No PSV Test record linked to Task ${taskId}. Exiting.`);
          return;
        }

        // 4. Load the PSV Test record
        const psvRec = record.load({ type: PSV_RECORD_TYPE, id: psvId });

        // 5. Render the Advanced PDF template against the PSV Test record
        const pdfFile = renderPsvPdf(psvRec);

        // 6. Build file name: PSV_Report_[WO#]_[MMDDYYYY].pdf
        var woNum = psvRec.getText({ fieldId: 'custrecord_bc_psv_work_order' }) || 'NOWO';

        if (woNum && woNum.indexOf('#') !== -1) {
           var parts = woNum.split('#');
           woNum = parts[1] ? parts[1].trim() : woNum;
        }
        const dateStr  = formatDateMMDDYYYY(new Date());
        const fileName = `PSV_Report_${sanitize(woNum)}_${dateStr}.pdf`;
        pdfFile.name = fileName;

        // 7. Create / find File Cabinet folder
        const rootFolderId = getOrCreateFolder(ROOT_FOLDER_NAME, null);
        const subFolderName = truncate(`Task-${taskId} – ${taskTitle}`, 100);
        const subFolderId = getOrCreateFolder(subFolderName, rootFolderId);
        pdfFile.folder = subFolderId;

        // 8. Save PDF to File Cabinet
        const fileId = pdfFile.save();
        log.audit('PSV PDF', `PDF saved: fileId=${fileId}, name=${fileName}`);

        // 9. Write file ID back to PSV Test record
        record.submitFields({
          type: PSV_RECORD_TYPE,
          id: psvId,
          values: { custrecord_bc_psv_pdf_file_id: fileId, custrecord_bc_psv_pdf_error: '' }
        });

        // 10. Attach PDF file to the Task record
        record.attach({
          record: { type: 'file', id: fileId },
          to:     { type: 'task', id: taskId }
        });

        // 11. Flag Task as generated & store folder ID
        record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_bc_psv_pdf_generated: true,
            custevent_bc_psv_folder_id: subFolderId,
            custevent_bc_psv_pdf: fileId,
            custevent_psv_error_log: ''
          }
        });

        log.audit('PSV PDF', `Successfully generated PDF for Task ${taskId}, PSV Test ${psvId}`);

      } catch (e) {
        log.error('PSV PDF Error', `Task ${taskId}: ${e.message}\n${e.stack}`);
        // Write error to PSV Test record if we found one
        try {
          const psvId = findPsvTestByTask(taskId);
          if (psvId) {
            record.submitFields({
              type: PSV_RECORD_TYPE,
              id: psvId,
              values: { custrecord_bc_psv_pdf_error: `${new Date().toISOString()} — ${e.message}` }
            });
          }
          record.submitFields({
            type: record.Type.TASK,
            id: taskId,
            values: {
              custevent_psv_error_log: `${new Date().toISOString()} — ${e.message}`
            }
          });
        } catch (inner) {
          log.error('PSV PDF Error', `Could not log error to PSV Test: ${inner.message}`);
        }
      }
    };

    /* ------------------------------------------------------------------ */
    /*  HELPER: Find PSV Test record linked to a Task                     */
    /* ------------------------------------------------------------------ */
    const findPsvTestByTask = (taskId) => {
      const results = search.create({
        type: PSV_RECORD_TYPE,
        filters: [
          ['custrecord_bc_psv_task', 'anyof', taskId]
        ],
        columns: ['internalid']
      }).run().getRange({ start: 0, end: 10 });

      return results.length ? results[0].id : null;
    };

    /* ------------------------------------------------------------------ */
    /*  HELPER: Render Advanced PDF using N/render                        */
    /*                                                                    */
    /*  Uses render.create() → TemplateRenderer for custom records.       */
    /*  The Advanced PDF template must be assigned to the PSV Test record.*/
    /* ------------------------------------------------------------------ */
    const renderPsvPdf = (psvRec) => {
      const renderer = render.create();

      // Point to the Advanced PDF template by its script ID
      renderer.setTemplateByScriptId({ scriptId: TEMPLATE_ID });

      // Bind the PSV Test record so template can reference its fields
      // In the template, fields are accessed as: record.custrecord_bc_psv_branch etc.
      renderer.addRecord({
        templateName: 'record',
        record: psvRec
      });

      // Render and return as PDF file object
      return renderer.renderAsPdf();
    };

    /* ------------------------------------------------------------------ */
    /*  HELPER: Get or create a File Cabinet folder                       */
    /* ------------------------------------------------------------------ */
    const getOrCreateFolder = (folderName, parentId) => {
      const filters = [['name', 'is', folderName]];
      if (parentId) {
        filters.push('AND', ['parent', 'anyof', parentId]);
      } else {
        filters.push('AND', ['parent', 'anyof', '@NONE@']);
      }

      const results = search.create({
        type: search.Type.FOLDER,
        filters: filters,
        columns: ['internalid']
      }).run().getRange({ start: 0, end: 1 });

      if (results.length) {
        return results[0].id;
      }

      const folderRec = record.create({ type: record.Type.FOLDER });
      folderRec.setValue({ fieldId: 'name', value: folderName });
      if (parentId) {
        folderRec.setValue({ fieldId: 'parent', value: parentId });
      }
      return folderRec.save();
    };

    /* ------------------------------------------------------------------ */
    /*  UTILITY HELPERS                                                   */
    /* ------------------------------------------------------------------ */
    const formatDateMMDDYYYY = (d) => {
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const yyyy = d.getFullYear();
      return `${mm}${dd}${yyyy}`;
    };

    const sanitize = (str) => String(str).replace(/[^a-zA-Z0-9_-]/g, '_');

    const truncate = (str, maxLen) => str.length > maxLen ? str.substring(0, maxLen) : str;

    return { beforeLoad, afterSubmit };
  });