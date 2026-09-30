<?php
/**
 * CSV and Excel exports for the PHP dashboard. The .xlsx is written by hand
 * with ZipArchive (an .xlsx is a zip of XML files), so no library is needed.
 * Same columns and sheets as the exports in dashboard.py.
 */
declare(strict_types=1);

function sp_rows_to_csv(array $rows): string
{
    $out = fopen('php://temp', 'r+');
    fputcsv($out, ['brand', 'model', 'part', 'source', 'price', 'currency', 'last_checked', 'url'], ',', '"', '\\', "\r\n");
    foreach ($rows as $row) {
        fputcsv($out, [$row['brand'], sp_clean_label($row['model']), $row['part'], $row['source'], $row['price_value'], $row['currency'], $row['date'], $row['url']], ',', '"', '\\', "\r\n");
    }
    rewind($out);
    return (string) stream_get_contents($out);
}

/** ISO timestamp -> Excel serial number carrying the India wall-clock time. */
function sp_excel_date($value): ?float
{
    $date = sp_parse_iso($value);
    if (!$date) {
        return null;
    }
    $local = $date->setTimezone(new DateTimeZone(SP_DISPLAY_TIMEZONE));
    $asUtc = gmmktime((int) $local->format('G'), (int) $local->format('i'), (int) $local->format('s'), (int) $local->format('n'), (int) $local->format('j'), (int) $local->format('Y'));
    return $asUtc / 86400 + 25569;
}

function sp_xml(string $text): string
{
    $text = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', '', $text) ?? $text;
    return htmlspecialchars($text, ENT_XML1 | ENT_QUOTES, 'UTF-8');
}

function sp_column_letter(int $index): string
{
    $letters = '';
    for ($n = $index; $n > 0; $n = intdiv($n - 1, 26)) {
        $letters = chr(65 + ($n - 1) % 26) . $letters;
    }
    return $letters;
}

/**
 * One worksheet's XML. $cells are strings, numbers, null, or ['date' => serial].
 * Styles: 0 plain, 1 money, 2 date, 3 header.
 */
function sp_sheet_xml(array $header, array $rows, array $widths, array $moneyColumns, array $dateColumns): string
{
    $xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        . '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        . '<cols>';
    foreach ($widths as $i => $width) {
        $xml .= '<col min="' . ($i + 1) . '" max="' . ($i + 1) . '" width="' . $width . '" customWidth="1"/>';
    }
    $xml .= '</cols><sheetData><row r="1">';
    foreach ($header as $i => $title) {
        $xml .= '<c r="' . sp_column_letter($i + 1) . '1" s="3" t="inlineStr"><is><t>' . sp_xml((string) $title) . '</t></is></c>';
    }
    $xml .= '</row>';
    $money = array_flip($moneyColumns);
    $dates = array_flip($dateColumns);
    foreach ($rows as $r => $cells) {
        $line = $r + 2;
        $xml .= '<row r="' . $line . '">';
        foreach ($cells as $i => $value) {
            $column = $i + 1;
            $ref = sp_column_letter($column) . $line;
            if ($value === null || $value === '') {
                continue;
            }
            if (isset($dates[$column]) && is_float($value)) {
                $xml .= '<c r="' . $ref . '" s="2"><v>' . $value . '</v></c>';
            } elseif (is_int($value) || is_float($value)) {
                $xml .= '<c r="' . $ref . '" s="' . (isset($money[$column]) ? 1 : 0) . '"><v>' . $value . '</v></c>';
            } else {
                $xml .= '<c r="' . $ref . '" t="inlineStr"><is><t xml:space="preserve">' . sp_xml((string) $value) . '</t></is></c>';
            }
        }
        $xml .= '</row>';
    }
    $xml .= '</sheetData>';
    if ($rows) {
        $xml .= '<autoFilter ref="A1:' . sp_column_letter(count($header)) . (count($rows) + 1) . '"/>';
    }
    return $xml . '</worksheet>';
}

/** Build the workbook (two sheets) and return the .xlsx bytes, or null when ZipArchive is unavailable. */
function sp_rows_to_excel(array $rows): ?string
{
    if (!class_exists('ZipArchive')) {
        return null;
    }
    $prices = [];
    foreach ($rows as $row) {
        $other = $row['competitors'][0] ?? null;
        $prices[] = [
            $row['brand'], sp_clean_label($row['model']), $row['part'], $row['category'] ?? '', $row['source'], $row['price_value'], $row['currency'] ?? '',
            $other ? $other['source'] : '', $other ? $other['part'] : '', $other ? $other['price_value'] : null, sp_excel_date($row['date']) ?? (string) $row['date'], $row['url'],
        ];
    }
    // One line per repair that both the brand and Cashify price, side by side.
    $compare = [];
    foreach ($rows as $row) {
        if ($row['source'] === 'Cashify') {
            continue;
        }
        foreach ($row['competitors'] ?? [] as $other) {
            if ($other['source'] !== 'Cashify' || $row['price_value'] === null || $other['price_value'] === null) {
                continue;
            }
            $difference = $row['price_value'] - $other['price_value'];
            $cheaper = $difference == 0 ? 'Same' : ($difference > 0 ? 'Cashify' : $row['source']);
            $compare[] = [$row['brand'], sp_clean_label($row['model']), $row['category'], $row['part'], $row['price_value'], $other['part'], $other['price_value'], $difference, $cheaper];
        }
    }

    $sheet1 = sp_sheet_xml(
        ['Brand', 'Model', 'Spare Part', 'Category', 'Source', 'Price', 'Currency', 'Other Source', 'Other Source Part', 'Other Source Price', 'Last Checked', 'Source URL'],
        $prices, [12, 30, 34, 16, 12, 12, 10, 14, 30, 18, 20, 60], [6, 10], [11],
    );
    $sheet2 = sp_sheet_xml(
        ['Brand', 'Model', 'Category', 'Official Part', 'Official Price', 'Cashify Part', 'Cashify Price', 'Difference (Official - Cashify)', 'Cheaper'],
        $compare, [12, 30, 16, 34, 16, 28, 16, 30, 12], [5, 7, 8], [],
    );
    $styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        . '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="dd-mmm-yyyy hh:mm"/></numFmts>'
        . '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>'
        . '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        . '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3A8A"/><bgColor indexed="64"/></patternFill></fill></fills>'
        . '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        . '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        . '<cellXfs count="4">'
        . '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        . '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        . '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        . '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>'
        . '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    $workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        . '<sheets><sheet name="Prices" sheetId="1" r:id="rId1"/><sheet name="Official vs Cashify" sheetId="2" r:id="rId2"/></sheets></workbook>';
    $workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        . '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        . '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        . '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        . '</Relationships>';
    $rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        . '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        . '</Relationships>';
    $contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        . '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        . '<Default Extension="xml" ContentType="application/xml"/>'
        . '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        . '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        . '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        . '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        . '</Types>';

    $file = tempnam(sys_get_temp_dir(), 'spx');
    $zip = new ZipArchive();
    if ($zip->open($file, ZipArchive::OVERWRITE) !== true) {
        return null;
    }
    $zip->addFromString('[Content_Types].xml', $contentTypes);
    $zip->addFromString('_rels/.rels', $rootRels);
    $zip->addFromString('xl/workbook.xml', $workbook);
    $zip->addFromString('xl/_rels/workbook.xml.rels', $workbookRels);
    $zip->addFromString('xl/styles.xml', $styles);
    $zip->addFromString('xl/worksheets/sheet1.xml', $sheet1);
    $zip->addFromString('xl/worksheets/sheet2.xml', $sheet2);
    $zip->close();
    $bytes = (string) file_get_contents($file);
    @unlink($file);
    return $bytes;
}
