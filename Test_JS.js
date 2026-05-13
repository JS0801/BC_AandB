/**
 * @NScriptType ScheduledScript
 * @NApiVersion 2.1
 */
define(['N/file'], (file) => {

    const execute = (context) => {

        try {

            var newFile = file.create({
                name:     'module_99DS.json',
                fileType: file.Type.JSON,
                contents: JSON.stringify({ test: 1234 }),
                folder:   8085,
                encoding: file.Encoding.UTF_8
            });

            var savedId = newFile.save();
            log.debug('Success', 'File saved. ID: ' + savedId);

        } catch (e) {
            log.error('Error', JSON.stringify(e));
        }

    };

    return { execute };

});
