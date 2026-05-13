/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope Public
 *
 * BC Inventory Picker Suitelet (v2)
 *
 * Renders an HTML page from a Sales Order line. User selects a source location
 * via radio button, then clicks Save to commit. Cancel discards.
 *
 * URL params (required): itemId, qtyRequired, destLocationId, subsidiaryId
 * URL params (optional): soId, lineId
 */
define(['N/search', 'N/log', 'N/record'], function (search, log, record) {

    function onRequest(context) {
        var req = context.request;
        var res = context.response;

        var itemId = req.parameters.itemId;
        var qtyRequired = parseFloat(req.parameters.qtyRequired || '0');
        var destLocationId = req.parameters.destLocationId;
        var subsidiaryId = req.parameters.subsidiaryId;
        var soId = req.parameters.soId || '';
        var lineId = req.parameters.lineId || '';

        if (!itemId || !qtyRequired || !destLocationId || !subsidiaryId) {
            res.write({
                output: renderError('Missing required parameters. itemId, qtyRequired, destLocationId, and subsidiaryId are all required.')
            });
            return;
        }

        var itemInfo = lookupItem(itemId);
        var destLocName = lookupLocation(destLocationId);

        var rows = [];
        try {
            rows = getInventoryRows(itemId, subsidiaryId, destLocationId, qtyRequired);
        } catch (e) {
            log.error('Picker query failed', e);
            res.write({ output: renderError('Could not load inventory: ' + e.message) });
            return;
        }

        res.write({
            output: renderPage({
                rows: rows,
                itemInfo: itemInfo,
                destLocName: destLocName,
                qtyRequired: qtyRequired,
                lineId: lineId,
                soId: soId
            })
        });
    }

    function lookupItem(itemId) {
        try {
            var fields = search.lookupFields({
                type: 'item',
                id: itemId,
                columns: ['itemid', 'displayname', 'type']
            });
            return {
                id: itemId,
                itemid: fields.itemid || '',
                displayname: fields.displayname || '',
                type: fields.type && fields.type[0] ? fields.type[0].text : ''
            };
        } catch (e) {
            return { id: itemId, itemid: '', displayname: '', type: '' };
        }
    }

    function lookupLocation(locId) {
        try {
            var fields = search.lookupFields({
                type: 'location',
                id: locId,
                columns: ['name']
            });
            return fields.name || '';
        } catch (e) {
            return '';
        }
    }

    function getInventoryRows(itemId, subsidiaryId, destLocationId, qtyRequired) {
        var filters = [
            ['item', 'anyof', itemId],
            'AND',
            ['location.subsidiary', 'anyof', subsidiaryId],
            'AND',
            ['location.isinactive', 'is', 'F']
        ];

        var columns = [
            search.createColumn({ name: 'location' }),
            search.createColumn({ name: 'onhand' }),
            search.createColumn({ name: 'available' }),
          //  search.createColumn({ name: 'locationonorder' }),
            search.createColumn({ name: 'invnumcommitted' })
        ];

        var rows = [];
        var s = search.create({ type: 'inventorybalance', filters: filters, columns: columns });

        s.run().each(function (r) {
            var locId = r.getValue({ name: 'location' });
            var locName = r.getText({ name: 'location' });
            var onHand = parseFloat(r.getValue({ name: 'onhand' }) || '0');
            var available = parseFloat(r.getValue({ name: 'available' }) || '0');
          //  var onOrder = parseFloat(r.getValue({ name: 'locationonorder' }) || '0');
            var committed = parseFloat(r.getValue({ name: 'invnumcommitted' }) || '0');

            var isDest = (String(locId) === String(destLocationId));
            var sufficient = (available >= qtyRequired);

            var status = 'Available';
            var disabled = false;
            if (isDest) {
                status = 'Destination Location';
                disabled = true;
            } else if (!sufficient) {
                status = 'Insufficient Available Qty';
                disabled = true;
            }

            rows.push({
                locId: locId,
                locName: locName,
                onHand: onHand,
                available: available,
             //   onOrder: onOrder,
                committed: committed,
                status: status,
                disabled: disabled
            });
            return true;
        });

        // Selectable first, sorted by available desc; disabled last
        rows.sort(function (a, b) {
            if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
            return b.available - a.available;
        });

        return rows;
    }

    function renderPage(ctx) {
        var rows = ctx.rows;
        var itemInfo = ctx.itemInfo;
        var destLocName = ctx.destLocName;
        var qtyRequired = ctx.qtyRequired;
        var lineId = ctx.lineId;
        var soId = ctx.soId;

        var rowHtml = rows.map(function (r, idx) {
            var rowClass = r.disabled ? 'row disabled' : 'row selectable';
            var radioId = 'loc_' + r.locId;
            var radioInput = r.disabled
                ? '<span class="radio-placeholder">—</span>'
                : '<input type="radio" name="locPick" id="' + radioId +
                  '" value="' + r.locId + '" data-name="' + escapeHtml(r.locName) +
                  '" onclick="handleRadioClick(this)">';
            var clickAttr = r.disabled
                ? ''
                : 'onclick="selectRow(\'' + radioId + '\')"';

            var availClass = r.disabled ? 'num' : (r.available >= qtyRequired ? 'num pos' : 'num');

            return [
                '<tr class="' + rowClass + '" id="row_' + r.locId + '" ' + clickAttr + '>',
                '<td class="radio-cell">' + radioInput + '</td>',
                '<td>' + escapeHtml(r.locName) + '</td>',
                '<td class="num">' + formatNum(r.onHand) + '</td>',
                '<td class="' + availClass + '">' + formatNum(r.available) + '</td>',
                '<td class="num">' + formatNum(r.committed) + '</td>',
                '<td class="status ' + (r.disabled ? 'status-disabled' : 'status-ok') + '">' + escapeHtml(r.status) + '</td>',
                '</tr>'
            ].join('');
        }).join('');

        if (!rowHtml) {
            rowHtml = '<tr><td colspan="7" class="empty">No locations found for this item in the current subsidiary.</td></tr>';
        }

        var itemLabel = itemInfo.itemid
            ? (itemInfo.itemid + (itemInfo.displayname ? ' — ' + itemInfo.displayname : ''))
            : ('Item #' + itemInfo.id);

        return [
            '<!DOCTYPE html>',
            '<html><head><meta charset="utf-8">',
            '<title>Select Source Location</title>',
            '<style>',
            '  * { box-sizing: border-box; }',
            '  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; margin: 0; padding: 0; background: #f5f7fa; color: #333; }',
            '  .container { padding: 18px 22px 80px 22px; }',
            '  .header { background: #fff; padding: 14px 22px; border-bottom: 2px solid #d4dae0; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }',
            '  h2 { font-size: 16px; margin: 0 0 6px 0; color: #2b3a4a; }',
            '  .meta { color: #555; font-size: 12px; line-height: 1.7; }',
            '  .meta-item { display: inline-block; margin-right: 18px; }',
            '  .meta-item strong { color: #2b3a4a; font-weight: 600; }',
            '  .table-wrap { background: #fff; border: 1px solid #d4dae0; border-radius: 4px; overflow: hidden; }',
            '  table { border-collapse: collapse; width: 100%; }',
            '  th { background: #f0f3f6; text-align: left; padding: 10px 12px; font-weight: 600; border-bottom: 2px solid #d4dae0; font-size: 12px; color: #455463; }',
            '  th.num, td.num { text-align: right; }',
            '  th.radio-cell, td.radio-cell { width: 36px; text-align: center; }',
            '  td { padding: 9px 12px; border-bottom: 1px solid #eaecef; vertical-align: middle; }',
            '  tr.selectable { cursor: pointer; transition: background 0.08s ease; }',
            '  tr.selectable:hover { background: #eaf4ff; }',
            '  tr.selectable.chosen { background: #d3eafd; }',
            '  tr.selectable.chosen td { font-weight: 600; }',
            '  tr.disabled { color: #aaa; background: #fafafa; cursor: not-allowed; }',
            '  td.empty { text-align: center; color: #888; padding: 24px; font-style: italic; }',
            '  td.pos { color: #1f8a4a; font-weight: 600; }',
            '  td.status { font-size: 12px; }',
            '  td.status-ok { color: #1f8a4a; }',
            '  td.status-disabled { color: #999; font-style: italic; }',
            '  .radio-placeholder { color: #ccc; }',
            '  input[type="radio"] { cursor: pointer; width: 16px; height: 16px; }',
            '  .footer { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; padding: 12px 22px; border-top: 1px solid #d4dae0; text-align: right; box-shadow: 0 -1px 3px rgba(0,0,0,0.05); }',
            '  .selection-summary { float: left; padding-top: 6px; font-size: 12px; color: #555; }',
            '  .selection-summary strong { color: #125ab2; }',
            '  button { padding: 7px 16px; font-size: 13px; cursor: pointer; border-radius: 3px; border: 1px solid #c0c6cc; background: #fff; color: #333; margin-left: 8px; }',
            '  button:hover:not(:disabled) { background: #f3f5f7; }',
            '  button.primary { background: #125ab2; color: #fff; border-color: #0e4a94; font-weight: 600; }',
            '  button.primary:hover:not(:disabled) { background: #0e4a94; }',
            '  button:disabled { opacity: 0.5; cursor: not-allowed; }',
            '</style>',
            '</head><body>',
            '<div class="header">',
            '  <h2>Select Source Location</h2>',
            '  <div class="meta">',
            '    <span class="meta-item">Item: <strong>' + escapeHtml(itemLabel) + '</strong></span>',
            '    <span class="meta-item">Qty Required: <strong>' + formatNum(qtyRequired) + '</strong></span>',
            '    <span class="meta-item">Destination: <strong>' + escapeHtml(destLocName || destLocName) + '</strong></span>',
            (soId ? '    <span class="meta-item">SO: <strong>#' + escapeHtml(soId) + '</strong></span>' : ''),
            '  </div>',
            '</div>',
            '<div class="container">',
            '  <div class="table-wrap">',
            '    <table>',
            '      <thead><tr>',
            '        <th class="radio-cell"></th>',
            '        <th>Location</th>',
            '        <th class="num">Qty On Hand</th>',
            '        <th class="num">Qty Available</th>',
            '        <th class="num">Qty Committed</th>',
            '        <th>Status</th>',
            '      </tr></thead>',
            '      <tbody>', rowHtml, '</tbody>',
            '    </table>',
            '  </div>',
            '</div>',
            '<div class="footer">',
            '  <div class="selection-summary" id="selectionSummary">No location selected</div>',
            '  <button type="button" onclick="cancelPicker()">Cancel</button>',
            '  <button type="button" class="primary" id="saveBtn" onclick="savePicker()" disabled>Save</button>',
            '</div>',
            '<script>',
            '  var selectedLocId = null;',
            '  var selectedLocName = null;',
            '',
            '  function selectRow(radioId) {',
            '    var radio = document.getElementById(radioId);',
            '    if (!radio) return;',
            '    radio.checked = true;',
            '    handleRadioClick(radio);',
            '  }',
            '',
            '  function handleRadioClick(radio) {',
            '    selectedLocId = radio.value;',
            '    selectedLocName = radio.getAttribute("data-name");',
            '',
            '    // Update row highlight',
            '    var rows = document.querySelectorAll("tr.selectable");',
            '    for (var i = 0; i < rows.length; i++) rows[i].classList.remove("chosen");',
            '    var chosenRow = document.getElementById("row_" + selectedLocId);',
            '    if (chosenRow) chosenRow.classList.add("chosen");',
            '',
            '    // Update summary + enable Save',
            '    document.getElementById("selectionSummary").innerHTML = "Selected: <strong>" + selectedLocName + "</strong>";',
            '    document.getElementById("saveBtn").disabled = false;',
            '  }',
            '',
            '  function cancelPicker() {',
            '    window.close();',
            '  }',
            '',
            '  function savePicker() {',
            '    if (!selectedLocId) return;',
            '    try {',
            '      if (window.opener && !window.opener.closed) {',
            '        var payload = { source: "bc_picker", lineId: "' + escapeJs(lineId) + '", locId: selectedLocId, locName: selectedLocName };',
            '        if (typeof window.opener.bcPickerCallback === "function") {',
            '          window.opener.bcPickerCallback(payload);',
            '        } else {',
            '          window.opener.postMessage(payload, "*");',
            '        }',
            '      }',
            '    } catch (e) {',
            '      console.error("Picker callback failed", e);',
            '    }',
            '    window.close();',
            '  }',
            '',
            '  // Keyboard: Enter saves, Esc cancels',
            '  document.addEventListener("keydown", function (e) {',
            '    if (e.key === "Enter" && selectedLocId) { e.preventDefault(); savePicker(); }',
            '    if (e.key === "Escape") { e.preventDefault(); cancelPicker(); }',
            '  });',
            '</script>',
            '</body></html>'
        ].join('\n');
    }

    function renderError(msg) {
        return [
            '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;">',
            '<h3 style="color:#c0392b;">Picker Error</h3>',
            '<p>' + escapeHtml(msg) + '</p>',
            '<button onclick="window.close()">Close</button>',
            '</body></html>'
        ].join('');
    }

    function formatNum(n) {
        if (n === null || n === undefined || isNaN(n)) return '0';
        return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeJs(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
    }

    return { onRequest: onRequest };
});
