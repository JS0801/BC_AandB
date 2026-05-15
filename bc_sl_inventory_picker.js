/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope Public
 *
 * BC Inventory Picker Suitelet (v3)
 *
 * Features:
 *   - Pre-selects a row if selectedLocId is passed (so user sees the current
 *     line's source location highlighted)
 *   - Read-only mode (readOnly=T) for view-mode access: no radio buttons,
 *     no Save, just a Close button — informational only
 *   - Save is allowed with NO selection — clearing the source location
 *   - "Clear Selection" link lets user de-select after picking
 *
 * URL params:
 *   itemId         (required) item internal ID
 *   qtyRequired    (required) decimal qty needed
 *   destLocationId (required) SO destination location to exclude
 *   subsidiaryId   (required) SO subsidiary
 *   selectedLocId  (optional) current source location to pre-select
 *   readOnly       (optional) "T" for read-only mode
 *   soId           (optional, audit only)
 *   lineId         (optional, round-trip identifier)
 */
define(['N/search', 'N/log'], function (search, log) {

    function onRequest(context) {
        var req = context.request;
        var res = context.response;

        var itemId = req.parameters.itemId;
        var qtyRequired = parseFloat(req.parameters.qtyRequired || '0');
        var destLocationId = req.parameters.destLocationId;
        var subsidiaryId = req.parameters.subsidiaryId;
        var selectedLocId = req.parameters.selectedLocId || '';
        var readOnly = (req.parameters.readOnly === 'T' || req.parameters.readOnly === 'true');
        var soId = req.parameters.soId || '';
        var lineId = req.parameters.lineId || '';

        if (!itemId || !qtyRequired || !destLocationId || !subsidiaryId) {
            res.write({ output: renderError('Missing required parameters.') });
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
                selectedLocId: selectedLocId,
                readOnly: readOnly,
                lineId: lineId,
                soId: soId
            })
        });
    }

    function lookupItem(itemId) {
        try {
            var fields = search.lookupFields({ type: 'item', id: itemId, columns: ['itemid', 'displayname', 'type'] });
            return {
                id: itemId,
                itemid: fields.itemid || '',
                displayname: fields.displayname || '',
                type: fields.type && fields.type[0] ? fields.type[0].text : ''
            };
        } catch (e) { return { id: itemId, itemid: '', displayname: '', type: '' }; }
    }

    function lookupLocation(locId) {
        try {
            var fields = search.lookupFields({ type: 'location', id: locId, columns: ['name'] });
            return fields.name || '';
        } catch (e) { return ''; }
    }

    function getInventoryRows(itemId, subsidiaryId, destLocationId, qtyRequired) {
        var filters = [
            ['item', 'anyof', itemId], 'AND',
            ['location.subsidiary', 'anyof', subsidiaryId], 'AND',
            ['location.isinactive', 'is', 'F']
        ];

        var columns = [
            search.createColumn({ name: 'location' }),
            search.createColumn({ name: 'available' }),
            search.createColumn({ name: 'onhand' }),
            search.createColumn({ name: 'invnumcommitted' })
        ];

        var rows = [];
        var s = search.create({ type: 'inventorybalance', filters: filters, columns: columns });

        s.run().each(function (r) {
            var locId = r.getValue({ name: 'location' });
            var locName = r.getText({ name: 'location' });
            var onHand = parseFloat(r.getValue({ name: 'onhand' }) || '0');
            var available = parseFloat(r.getValue({ name: 'available' }) || '0');
            var committed = parseFloat(r.getValue({ name: 'invnumcommitted' }) || '0');

            var isDest = (String(locId) === String(destLocationId));
            var sufficient = (available >= qtyRequired);
            var status = 'Available';
            var disabled = false;
            if (isDest) { status = 'Destination Location'; disabled = true; }
            else if (!sufficient) { status = 'Insufficient Available Qty'; disabled = true; }

            rows.push({
                locId: locId, locName: locName,
                onHand: onHand, available: available, committed: committed,
                status: status, disabled: disabled
            });
            return true;
        });

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
        var selectedLocId = String(ctx.selectedLocId || '');
        var readOnly = !!ctx.readOnly;
        var lineId = ctx.lineId;
        var soId = ctx.soId;

        var rowHtml = rows.map(function (r) {
            var isPreSelected = (String(r.locId) === selectedLocId);
            var rowClass = 'row';
            if (r.disabled) rowClass += ' disabled';
            else rowClass += ' selectable';
            if (isPreSelected && !r.disabled) rowClass += ' chosen';
            if (isPreSelected && r.disabled) rowClass += ' chosen-disabled';

            var radioId = 'loc_' + r.locId;
            var radioInput;
            if (readOnly) {
                radioInput = isPreSelected
                    ? '<span class="check-mark">✓</span>'
                    : '<span class="radio-placeholder">—</span>';
            } else if (r.disabled) {
                radioInput = isPreSelected
                    ? '<input type="radio" name="locPick" id="' + radioId +
                      '" value="' + r.locId + '" data-name="' + escapeHtml(r.locName) +
                      '" checked disabled>'
                    : '<span class="radio-placeholder">—</span>';
            } else {
                radioInput = '<input type="radio" name="locPick" id="' + radioId +
                    '" value="' + r.locId + '" data-name="' + escapeHtml(r.locName) +
                    '"' + (isPreSelected ? ' checked' : '') +
                    ' onclick="handleRadioClick(this)">';
            }

            var clickAttr = (readOnly || r.disabled)
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
                '<td class="num">' + formatNum(r.onOrder) + '</td>',
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

        // Initial summary text
        var initialSummary = '';
        if (selectedLocId) {
            var match = rows.filter(function (r) { return String(r.locId) === selectedLocId; })[0];
            initialSummary = match
                ? 'Selected: <strong>' + escapeHtml(match.locName) + '</strong>'
                : 'Selected: <strong>(location #' + escapeHtml(selectedLocId) + ' not in current results)</strong>';
        } else {
            initialSummary = readOnly ? 'No source location set' : 'No location selected';
        }

        // Footer changes based on read-only
        var footerHtml;
        if (readOnly) {
            footerHtml = [
                '<div class="footer">',
                '  <div class="selection-summary">' + initialSummary + '</div>',
                '  <button type="button" onclick="window.close()">Close</button>',
                '</div>'
            ].join('');
        } else {
            footerHtml = [
                '<div class="footer">',
                '  <div class="selection-summary" id="selectionSummary">' + initialSummary + '</div>',
                '  <a href="javascript:void(0)" id="clearLink" onclick="clearSelection()" style="margin-right:14px;font-size:12px;color:#125ab2;text-decoration:underline;' + (selectedLocId ? '' : 'display:none;') + '">Clear selection</a>',
                '  <button type="button" onclick="cancelPicker()">Cancel</button>',
                '  <button type="button" class="primary" id="saveBtn" onclick="savePicker()">Save</button>',
                '</div>'
            ].join('');
        }

        return [
            '<!DOCTYPE html>',
            '<html><head><meta charset="utf-8">',
            '<title>' + (readOnly ? 'View ' : 'Select ') + 'Source Location</title>',
            '<style>',
            '  * { box-sizing: border-box; }',
            '  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; margin: 0; padding: 0; background: #f5f7fa; color: #333; }',
            '  .container { padding: 18px 22px 80px 22px; }',
            '  .header { background: #fff; padding: 14px 22px; border-bottom: 2px solid #d4dae0; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }',
            '  h2 { font-size: 16px; margin: 0 0 6px 0; color: #2b3a4a; }',
            '  .read-only-badge { display: inline-block; background: #f0ad4e; color: #fff; padding: 2px 8px; font-size: 11px; border-radius: 3px; margin-left: 8px; vertical-align: middle; }',
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
            '  tr.chosen-disabled { background: #fff7e6; }',
            '  tr.chosen-disabled td:first-child { color: #f0ad4e; font-weight: 600; }',
            '  tr.disabled { color: #aaa; background: #fafafa; cursor: not-allowed; }',
            '  td.empty { text-align: center; color: #888; padding: 24px; font-style: italic; }',
            '  td.pos { color: #1f8a4a; font-weight: 600; }',
            '  td.status { font-size: 12px; }',
            '  td.status-ok { color: #1f8a4a; }',
            '  td.status-disabled { color: #999; font-style: italic; }',
            '  .radio-placeholder { color: #ccc; }',
            '  .check-mark { color: #1f8a4a; font-weight: 700; font-size: 16px; }',
            '  input[type="radio"] { cursor: pointer; width: 16px; height: 16px; }',
            '  .footer { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; padding: 12px 22px; border-top: 1px solid #d4dae0; text-align: right; box-shadow: 0 -1px 3px rgba(0,0,0,0.05); }',
            '  .selection-summary { float: left; padding-top: 6px; font-size: 12px; color: #555; }',
            '  .selection-summary strong { color: #125ab2; }',
            '  button { padding: 7px 16px; font-size: 13px; cursor: pointer; border-radius: 3px; border: 1px solid #c0c6cc; background: #fff; color: #333; margin-left: 8px; }',
            '  button:hover:not(:disabled) { background: #f3f5f7; }',
            '  button.primary { background: #125ab2; color: #fff; border-color: #0e4a94; font-weight: 600; }',
            '  button.primary:hover:not(:disabled) { background: #0e4a94; }',
            '</style>',
            '</head><body>',
            '<div class="header">',
            '  <h2>' + (readOnly ? 'View ' : 'Select ') + 'Source Location' + (readOnly ? '<span class="read-only-badge">VIEW ONLY</span>' : '') + '</h2>',
            '  <div class="meta">',
            '    <span class="meta-item">Item: <strong>' + escapeHtml(itemLabel) + '</strong></span>',
            '    <span class="meta-item">Qty Required: <strong>' + formatNum(qtyRequired) + '</strong></span>',
            '    <span class="meta-item">Destination: <strong>' + escapeHtml(destLocName) + '</strong></span>',
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
            '        <th class="num">Qty On Order</th>',
            '        <th>Status</th>',
            '      </tr></thead>',
            '      <tbody>', rowHtml, '</tbody>',
            '    </table>',
            '  </div>',
            '</div>',
            footerHtml,
            '<script>',
            '  var selectedLocId = ' + (selectedLocId ? '"' + escapeJs(selectedLocId) + '"' : 'null') + ';',
            '  var selectedLocName = null;',
            '  var initialSelectedLocId = selectedLocId;',
            (selectedLocId
                ? '  (function(){var r=document.getElementById("loc_' + escapeJs(selectedLocId) + '");if(r){selectedLocName=r.getAttribute("data-name");}})();'
                : ''),
            '',
            '  function selectRow(radioId) {',
            '    var radio = document.getElementById(radioId);',
            '    if (!radio || radio.disabled) return;',
            '    radio.checked = true;',
            '    handleRadioClick(radio);',
            '  }',
            '',
            '  function handleRadioClick(radio) {',
            '    selectedLocId = radio.value;',
            '    selectedLocName = radio.getAttribute("data-name");',
            '    var rs = document.querySelectorAll("tr.selectable");',
            '    for (var i = 0; i < rs.length; i++) rs[i].classList.remove("chosen");',
            '    var cr = document.getElementById("row_" + selectedLocId);',
            '    if (cr) cr.classList.add("chosen");',
            '    var sm = document.getElementById("selectionSummary");',
            '    if (sm) sm.innerHTML = "Selected: <strong>" + selectedLocName + "</strong>";',
            '    var cl = document.getElementById("clearLink");',
            '    if (cl) cl.style.display = "";',
            '  }',
            '',
            '  function clearSelection() {',
            '    selectedLocId = null;',
            '    selectedLocName = null;',
            '    var radios = document.querySelectorAll("input[name=locPick]");',
            '    for (var i = 0; i < radios.length; i++) radios[i].checked = false;',
            '    var rs = document.querySelectorAll("tr.selectable");',
            '    for (var j = 0; j < rs.length; j++) rs[j].classList.remove("chosen");',
            '    var sm = document.getElementById("selectionSummary");',
            '    if (sm) sm.innerHTML = "No location selected";',
            '    var cl = document.getElementById("clearLink");',
            '    if (cl) cl.style.display = "none";',
            '  }',
            '',
            '  function cancelPicker() { window.close(); }',
            '',
            '  function savePicker() {',
            '    try {',
            '      if (window.opener && !window.opener.closed) {',
            '        var payload = {',
            '          source: "bc_picker",',
            '          lineId: "' + escapeJs(lineId) + '",',
            '          locId: selectedLocId || "",',
            '          locName: selectedLocName || ""',
            '        };',
            '        if (typeof window.opener.bcPickerCallback === "function") {',
            '          window.opener.bcPickerCallback(payload);',
            '        } else {',
            '          window.opener.postMessage(payload, "*");',
            '        }',
            '      }',
            '    } catch (e) { console.error("Picker callback failed", e); }',
            '    window.close();',
            '  }',
            '',
            '  document.addEventListener("keydown", function (e) {',
            '    if (e.key === "Enter") {' + (readOnly ? ' e.preventDefault(); window.close();' : ' e.preventDefault(); savePicker();') + ' }',
            '    if (e.key === "Escape") { e.preventDefault(); window.close(); }',
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
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function escapeJs(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
    }

    return { onRequest: onRequest };
});