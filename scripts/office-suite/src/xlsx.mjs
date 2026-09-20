// xlsx_create: CSV / JSON / Markdown tables -> Excel workbook; xlsx_update: edit a workbook.
import path from "node:path";
import ExcelJS from "exceljs";
import {
  finish,
  inputFile,
  outputFile,
  parse,
  parseDelimited,
  readText,
  ToolError,
  typedValue,
} from "./common.mjs";
import { blocks, plain } from "./markdown.mjs";

const createUsage = `
xlsx_create --output <file.xlsx> --input <data.csv|.tsv|.json|.md> [--input <more> ...]
  [--sheet 工作表名 ...] [--sum "列A,列B"|auto] [--average "列C"] [--total-label 合计]
  [--formula "金额=数量*单价" ...] [--number-format "金额=#,##0.00" ...]
  [--no-header] [--no-freeze] [--no-filter]
CSV: first row is the header; numbers, dates (2026-09-20), percentages and =formulas are typed.
--formula "新列=表头表达式" adds a computed column (+ - * / and parentheses over header names) with
cached results; "列==IF(C{row}>=60,\\"及格\\",\\"不及格\\")" writes a raw Excel formula per row.
JSON: [[...],[...]] | [{...}] | {"表名":[...]} | {"sheets":[{"name","header","rows","formulas":{},
"sum":[],"average":[],"numberFormats":{},"widths":{},"cells":{"A10":"备注"},"merge":["A10:D10"]}]}.
Markdown: every table becomes a sheet.`;

const updateUsage = `
xlsx_update --file <book.xlsx> [--output <other.xlsx>] [--sheet <name|index>]
  [--set "B2=42" ...] [--set "C2==SUM(A2:B2)" ...] [--set "Sheet2!A1=标题" ...]
  [--append-row '["张三",3,"=B5*2"]' ...] [--append-csv more.csv [--skip-header]]
  [--add-sheet 名称 ...] [--rename-sheet "旧名=新名" ...] [--delete-sheet 名称 ...]
Edits in place unless --output is given. Charts, pivot tables and macros of the original
workbook are not preserved; use Excel itself (COM) for such workbooks.`;

function displayWidth(value) {
  let width = 0;
  for (const char of String(value ?? "")) width += /[\u2e80-\uffef]/.test(char) ? 2 : 1;
  return width;
}

function sheetName(raw, used) {
  let name = String(raw ?? "").replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  const base = name;
  for (let index = 2; used.has(name.toLowerCase()); index++)
    name = `${base.slice(0, 31 - String(index).length - 1)} ${index}`;
  used.add(name.toLowerCase());
  return name;
}

function columnLetter(index) {
  let letters = "";
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26))
    letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
  return letters;
}

function list(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "")
    .split(/[,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Compile "数量*单价" into per-row Excel text and a cached numeric result.
 * Header names are matched longest first; anything else must be a number or + - * / ( ).
 */
function headerExpression(expression, header) {
  const names = header
    .map((name, index) => ({ name: String(name), index }))
    .filter((item) => item.name)
    .sort((a, b) => b.name.length - a.name.length);
  const tokens = [];
  let rest = expression.trim();
  while (rest) {
    const space = /^\s+/.exec(rest);
    if (space) {
      rest = rest.slice(space[0].length);
      continue;
    }
    const number = /^\d+(\.\d+)?/.exec(rest);
    const name = names.find((item) => rest.startsWith(item.name));
    if (name) {
      tokens.push({ column: name.index });
      rest = rest.slice(name.name.length);
    } else if (number) {
      tokens.push({ number: Number(number[0]) });
      rest = rest.slice(number[0].length);
    } else if ("+-*/()".includes(rest[0])) {
      tokens.push({ operator: rest[0] });
      rest = rest.slice(1);
    } else return undefined;
  }
  return {
    text: (row) =>
      tokens
        .map((token) =>
          token.column !== undefined
            ? `${columnLetter(token.column + 1)}${row}`
            : (token.operator ?? String(token.number)),
        )
        .join(""),
    value: (cells) => {
      let position = 0;
      const peek = () => tokens[position];
      const primary = () => {
        const token = tokens[position++];
        if (!token) return NaN;
        if (token.number !== undefined) return token.number;
        if (token.column !== undefined) {
          const cell = cells[token.column];
          const value =
            cell && typeof cell === "object"
              ? (cell.result ?? cell.percent ?? NaN)
              : cell;
          return typeof value === "number" ? value : NaN;
        }
        if (token.operator === "(") {
          const inner = sum();
          position++;
          return inner;
        }
        if (token.operator === "-") return -primary();
        return NaN;
      };
      const product = () => {
        let value = primary();
        while (peek()?.operator === "*" || peek()?.operator === "/") {
          const operator = tokens[position++].operator;
          const right = primary();
          value = operator === "*" ? value * right : value / right;
        }
        return value;
      };
      const sum = () => {
        let value = product();
        while (peek()?.operator === "+" || peek()?.operator === "-") {
          const operator = tokens[position++].operator;
          const right = product();
          value = operator === "+" ? value + right : value - right;
        }
        return value;
      };
      const result = sum();
      return Number.isFinite(result) ? Math.round(result * 1e10) / 1e10 : undefined;
    },
  };
}

function numeric(cell) {
  if (typeof cell === "number") return cell;
  if (cell && typeof cell === "object") {
    if (typeof cell.result === "number") return cell.result;
    if (typeof cell.percent === "number") return cell.percent;
  }
  return undefined;
}

/** Write one table (header + typed rows + options) into a worksheet. */
function writeSheet(worksheet, table, options) {
  const header = table.header ? table.header.map((item) => String(item ?? "")) : undefined;
  const rows = table.rows.map((row) => row.map((cell) => typedValue(cell)));
  const columnsOf = () => Math.max(header?.length ?? 0, ...rows.map((row) => row.length), 1);
  const formulas = [];
  if (header)
    for (const [target, expression] of Object.entries(table.formulas ?? {})) {
      let column = header.indexOf(target);
      if (column < 0) {
        header.push(target);
        column = header.length - 1;
      }
      if (String(expression).startsWith("=")) {
        const template = String(expression).slice(1);
        rows.forEach((row, index) => {
          row[column] = { formula: template.replaceAll("{row}", String(index + 2)) };
        });
      } else {
        const compiled = headerExpression(String(expression), header);
        if (!compiled)
          throw new ToolError(
            "BAD_FORMULA",
            `Cannot read formula "${target}=${expression}": use header names, numbers and + - * / ( ), or start the right side with = for a raw Excel formula with {row}`,
          );
        rows.forEach((row, index) => {
          row[column] = { formula: compiled.text(index + 2), result: compiled.value(row) };
        });
      }
      formulas.push(target);
    }
  const width = columnsOf();
  const firstData = header ? 2 : 1;
  if (header) worksheet.addRow(header);
  for (const row of rows) {
    const values = Array.from({ length: width }, (_, column) => {
      const cell = row[column];
      if (cell && typeof cell === "object" && !(cell instanceof Date)) {
        if ("formula" in cell)
          return cell.result === undefined
            ? { formula: cell.formula }
            : { formula: cell.formula, result: cell.result };
        if ("percent" in cell) return cell.percent;
        if ("date" in cell) return cell.date;
      }
      return cell ?? null;
    });
    const added = worksheet.addRow(values);
    row.forEach((cell, column) => {
      if (!cell || typeof cell !== "object") return;
      if ("percent" in cell) added.getCell(column + 1).numFmt = "0.00%";
      if ("date" in cell)
        added.getCell(column + 1).numFmt = cell.time ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd";
    });
  }
  const lastData = firstData + rows.length - 1;
  const totals = [];
  const resolve = (names, kind) => {
    if (!header || !names?.length) return;
    const selected =
      names.length === 1 && names[0].toLowerCase() === "auto"
        ? header.filter((_, column) =>
            rows.length && rows.every((row) => row[column] == null || numeric(row[column]) !== undefined) &&
            rows.some((row) => numeric(row[column]) !== undefined),
          )
        : names;
    for (const name of selected) {
      const column = header.indexOf(name);
      if (column < 0)
        throw new ToolError(
          "UNKNOWN_COLUMN",
          `Column "${name}" is not in the header: ${header.join(", ")}`,
        );
      totals.push({ column, kind });
    }
  };
  resolve(table.sum, "SUM");
  resolve(table.average, "AVERAGE");
  if (totals.length && rows.length) {
    const values = Array.from({ length: width }, () => null);
    for (const { column, kind } of totals) {
      const numbers = rows.map((row) => numeric(row[column])).filter((value) => value !== undefined);
      const total = numbers.reduce((sum, value) => sum + value, 0);
      const letter = columnLetter(column + 1);
      values[column] = {
        formula: `${kind}(${letter}${firstData}:${letter}${lastData})`,
        result:
          Math.round((kind === "SUM" ? total : numbers.length ? total / numbers.length : 0) * 1e10) /
          1e10,
      };
    }
    if (values[0] === null) values[0] = table.totalLabel ?? "合计";
    const added = worksheet.addRow(values);
    added.font = { bold: true };
    added.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { top: { style: "thin", color: { argb: "FF7F7F7F" } } };
    });
  }
  if (header) {
    const top = worksheet.getRow(1);
    top.font = { bold: true, color: { argb: "FF1F2937" } };
    top.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    top.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDEEAF6" } };
      cell.border = { bottom: { style: "thin", color: { argb: "FF7F7F7F" } } };
    });
    if (options.freeze) worksheet.views = [{ state: "frozen", ySplit: 1 }];
    if (options.filter && rows.length)
      worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: width } };
  }
  for (let column = 1; column <= width; column++) {
    let widest = displayWidth(header?.[column - 1] ?? "");
    for (const row of rows) {
      const cell = row[column - 1];
      const shown =
        cell && typeof cell === "object"
          ? "date" in cell
            ? "2026-01-01 00:00"
            : String(cell.result ?? cell.percent ?? "")
          : cell;
      widest = Math.max(widest, displayWidth(shown));
    }
    const name = header?.[column - 1];
    worksheet.getColumn(column).width =
      Number(table.widths?.[name]) || Math.min(60, Math.max(8, widest + 2));
    const format = table.numberFormats?.[name];
    if (format)
      for (let row = firstData; row <= worksheet.rowCount; row++)
        worksheet.getCell(row, column).numFmt = format;
  }
  for (const [address, raw] of Object.entries(table.cells ?? {})) {
    const value = typedValue(typeof raw === "object" && raw !== null ? raw.value : raw);
    const cell = worksheet.getCell(address);
    cell.value =
      value && typeof value === "object" && "formula" in value
        ? { formula: value.formula }
        : value && typeof value === "object" && "date" in value
          ? value.date
          : value && typeof value === "object" && "percent" in value
            ? value.percent
            : value;
    if (raw && typeof raw === "object") {
      if (raw.bold) cell.font = { bold: true };
      if (raw.numFmt) cell.numFmt = raw.numFmt;
      if (raw.fill)
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: `FF${String(raw.fill).replace(/^#/, "").toUpperCase()}` },
        };
    }
  }
  for (const range of table.merge ?? []) worksheet.mergeCells(range);
  return { name: worksheet.name, rows: rows.length, columns: width, formulas: formulas.length + totals.length };
}

function tablesFromJson(value, fallbackName) {
  const fromRecords = (records, name) => {
    if (records.every((row) => Array.isArray(row)))
      return { name, header: records[0], rows: records.slice(1) };
    const header = [];
    for (const record of records)
      for (const key of Object.keys(record ?? {})) if (!header.includes(key)) header.push(key);
    return { name, header, rows: records.map((record) => header.map((key) => record?.[key] ?? null)) };
  };
  if (Array.isArray(value)) return [fromRecords(value, fallbackName)];
  if (value && typeof value === "object") {
    if (Array.isArray(value.sheets))
      return value.sheets.map((sheet, index) => {
        const rows = sheet.rows ?? sheet.data ?? [];
        if (sheet.header || !rows.length || Array.isArray(rows[0]))
          return {
            ...sheet,
            name: sheet.name ?? `Sheet${index + 1}`,
            header: sheet.header ?? sheet.columns?.map((column) => column.header ?? column),
            rows: sheet.header || sheet.columns ? rows : rows.slice(1),
            ...(sheet.header || sheet.columns ? {} : { header: rows[0] }),
          };
        return { ...sheet, ...fromRecords(rows, sheet.name ?? `Sheet${index + 1}`) };
      });
    const entries = Object.entries(value).filter(([, rows]) => Array.isArray(rows));
    if (entries.length) return entries.map(([name, rows]) => fromRecords(rows, name));
  }
  throw new ToolError(
    "BAD_JSON_SHAPE",
    "JSON must be an array of rows/records, {sheetName: rows} or {sheets:[...]}",
    createUsage.trim(),
  );
}

export async function xlsxCreate(argv) {
  const { values } = parse(
    argv,
    {
      input: { type: "string", multiple: true },
      output: { type: "string" },
      sheet: { type: "string", multiple: true },
      sum: { type: "string" },
      average: { type: "string" },
      "total-label": { type: "string" },
      formula: { type: "string", multiple: true },
      "number-format": { type: "string", multiple: true },
      "no-header": { type: "boolean", default: false },
      "no-freeze": { type: "boolean", default: false },
      "no-filter": { type: "boolean", default: false },
    },
    createUsage,
  );
  if (!values.output || !values.input?.length)
    throw new ToolError("USAGE", "--input and --output are required", createUsage.trim());
  const output = await outputFile(values.output, ".xlsx");
  const pairs = (items, label) =>
    Object.fromEntries(
      (items ?? []).map((item) => {
        const index = item.indexOf("=");
        if (index < 1)
          throw new ToolError("USAGE", `${label} must look like "列名=内容": ${item}`);
        return [item.slice(0, index).trim(), item.slice(index + 1)];
      }),
    );
  const formulas = pairs(values.formula, "--formula");
  const numberFormats = pairs(values["number-format"], "--number-format");
  const tables = [];
  for (const item of values.input) {
    const file = await inputFile(item);
    const text = await readText(file);
    const base = path.basename(file, path.extname(file));
    if (/\.json$/i.test(file)) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new ToolError("BAD_JSON", `${file}: ${error.message}`);
      }
      tables.push(...tablesFromJson(parsed, base));
    } else if (/\.(md|markdown)$/i.test(file)) {
      let heading;
      for (const token of blocks(text)) {
        if (token.type === "heading") heading = plain(token.tokens);
        if (token.type !== "table") continue;
        tables.push({
          name: heading ?? base,
          header: token.header.map((cell) => plain(cell.tokens)),
          rows: token.rows.map((row) => row.map((cell) => plain(cell.tokens))),
        });
      }
      if (!tables.length) throw new ToolError("NO_TABLE", `${file} contains no Markdown table`);
    } else {
      const rows = parseDelimited(text, /\.tsv$/i.test(file) ? "\t" : undefined);
      if (!rows.length) throw new ToolError("EMPTY_INPUT", `${file} has no rows`);
      tables.push(
        values["no-header"]
          ? { name: base, rows }
          : { name: base, header: rows[0], rows: rows.slice(1) },
      );
    }
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "HarnessHub";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  const used = new Set();
  const sheets = tables.map((table, index) => {
    const worksheet = workbook.addWorksheet(
      sheetName(values.sheet?.[index] ?? table.name, used),
    );
    return writeSheet(
      worksheet,
      {
        ...table,
        formulas: { ...formulas, ...(table.formulas ?? {}) },
        numberFormats: { ...numberFormats, ...(table.numberFormats ?? {}) },
        sum: table.sum ?? (values.sum ? list(values.sum) : undefined),
        average: table.average ?? (values.average ? list(values.average) : undefined),
        totalLabel: table.totalLabel ?? values["total-label"],
      },
      { freeze: !values["no-freeze"], filter: !values["no-filter"] },
    );
  });
  await workbook.xlsx.writeFile(output);
  finish({ output, sheets });
}

function findSheet(workbook, selector) {
  if (selector === undefined) return workbook.worksheets[0];
  const byName = workbook.worksheets.find(
    (sheet) => sheet.name.toLowerCase() === String(selector).toLowerCase(),
  );
  if (byName) return byName;
  if (/^\d+$/.test(String(selector))) return workbook.worksheets[Number(selector) - 1];
  return undefined;
}

function cellValue(raw) {
  const value = typedValue(raw);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    if ("formula" in value) return { value: { formula: value.formula } };
    if ("percent" in value) return { value: value.percent, numFmt: "0.00%" };
    if ("date" in value)
      return { value: value.date, numFmt: value.time ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd" };
  }
  return { value };
}

export async function xlsxUpdate(argv) {
  const { values } = parse(
    argv,
    {
      file: { type: "string" },
      output: { type: "string" },
      sheet: { type: "string" },
      set: { type: "string", multiple: true },
      "append-row": { type: "string", multiple: true },
      "append-csv": { type: "string", multiple: true },
      "skip-header": { type: "boolean", default: false },
      "add-sheet": { type: "string", multiple: true },
      "rename-sheet": { type: "string", multiple: true },
      "delete-sheet": { type: "string", multiple: true },
    },
    updateUsage,
  );
  if (!values.file) throw new ToolError("USAGE", "--file is required", updateUsage.trim());
  const file = await inputFile(values.file, "workbook");
  const output = values.output ? await outputFile(values.output, ".xlsx") : file;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(file);
  } catch (error) {
    throw new ToolError(
      "UNREADABLE_WORKBOOK",
      `${file}: ${error.message}`,
      "Only .xlsx/.xlsm workbooks are supported; convert .xls with Excel first.",
    );
  }
  const changes = [];
  const used = new Set(workbook.worksheets.map((sheet) => sheet.name.toLowerCase()));
  for (const name of values["add-sheet"] ?? []) {
    const created = workbook.addWorksheet(sheetName(name, used));
    changes.push(`added sheet ${created.name}`);
  }
  for (const item of values["rename-sheet"] ?? []) {
    const index = item.indexOf("=");
    const sheet = findSheet(workbook, item.slice(0, index).trim());
    if (index < 1 || !sheet)
      throw new ToolError("UNKNOWN_SHEET", `--rename-sheet "旧名=新名": ${item}`);
    used.delete(sheet.name.toLowerCase());
    sheet.name = sheetName(item.slice(index + 1), used);
    changes.push(`renamed sheet to ${sheet.name}`);
  }
  const target = () => {
    const sheet = findSheet(workbook, values.sheet);
    if (!sheet)
      throw new ToolError(
        "UNKNOWN_SHEET",
        `Sheet "${values.sheet}" not found; sheets: ${workbook.worksheets.map((item) => item.name).join(", ")}`,
      );
    return sheet;
  };
  for (const item of values.set ?? []) {
    const match = /^(?:(.+)!)?(\$?[A-Za-z]{1,3}\$?\d{1,7})=(.*)$/s.exec(item);
    if (!match) throw new ToolError("USAGE", `--set must look like "B2=值" or "表名!B2=值": ${item}`);
    const sheet = match[1] ? findSheet(workbook, match[1].replace(/^'|'$/g, "")) : target();
    if (!sheet) throw new ToolError("UNKNOWN_SHEET", `Sheet "${match[1]}" not found`);
    const cell = sheet.getCell(match[2].replaceAll("$", "").toUpperCase());
    const next = cellValue(match[3]);
    cell.value = next.value;
    if (next.numFmt) cell.numFmt = next.numFmt;
    changes.push(`${sheet.name}!${cell.address}`);
  }
  const append = (sheet, cells) => {
    const row = sheet.addRow(cells.map((cell) => cellValue(cell).value));
    cells.forEach((cell, index) => {
      const format = cellValue(cell).numFmt;
      if (format) row.getCell(index + 1).numFmt = format;
    });
    return row.number;
  };
  for (const item of values["append-row"] ?? []) {
    let cells;
    try {
      cells = JSON.parse(item);
    } catch {
      cells = parseDelimited(item)[0] ?? [];
    }
    if (!Array.isArray(cells))
      throw new ToolError("USAGE", `--append-row needs a JSON array: ${item}`);
    const sheet = target();
    changes.push(`${sheet.name}: appended row ${append(sheet, cells)}`);
  }
  for (const item of values["append-csv"] ?? []) {
    const rows = parseDelimited(await readText(await inputFile(item)));
    const sheet = target();
    const data = values["skip-header"] ? rows.slice(1) : rows;
    for (const cells of data) append(sheet, cells);
    changes.push(`${sheet.name}: appended ${data.length} rows from ${path.basename(item)}`);
  }
  for (const name of values["delete-sheet"] ?? []) {
    const sheet = findSheet(workbook, name);
    if (!sheet) throw new ToolError("UNKNOWN_SHEET", `Sheet "${name}" not found`);
    if (workbook.worksheets.length === 1)
      throw new ToolError("LAST_SHEET", "A workbook must keep at least one sheet");
    workbook.removeWorksheet(sheet.id);
    changes.push(`deleted sheet ${name}`);
  }
  if (!changes.length) throw new ToolError("USAGE", "Nothing to change", updateUsage.trim());
  workbook.calcProperties.fullCalcOnLoad = true;
  await workbook.xlsx.writeFile(output);
  finish({
    output,
    changes,
    sheets: workbook.worksheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rowCount,
      columns: sheet.columnCount,
    })),
  });
}
