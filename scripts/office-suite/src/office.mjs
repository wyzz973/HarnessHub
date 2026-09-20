// Entry point of packs/office-suite/bin/office.cjs. cli.json registers one tool per
// command with the command name as fixed first argument; modules load on demand so that a
// light command never pays for the spreadsheet or presentation libraries.
import { run, ToolError } from "./common.mjs";

const COMMANDS = {
  docx_create: async () => (await import("./docx-create.mjs")).docxCreate,
  xlsx_create: async () => (await import("./xlsx.mjs")).xlsxCreate,
  xlsx_update: async () => (await import("./xlsx.mjs")).xlsxUpdate,
  pptx_create: async () => (await import("./pptx-create.mjs")).pptxCreate,
  office_read: async () => (await import("./office-read.mjs")).officeRead,
  pdf_create: async () => (await import("./pdf-create.mjs")).pdfCreate,
  ics_create: async () => (await import("./ics-create.mjs")).icsCreate,
  eml_create: async () => (await import("./eml-create.mjs")).emlCreate,
  app_open: async () => (await import("./app.mjs")).appOpen,
  app_close: async () => (await import("./app.mjs")).appClose,
  app_list: async () => (await import("./app.mjs")).appList,
  outlook_mail: async () => (await import("./outlook.mjs")).outlookMail,
  outlook_event: async () => (await import("./outlook.mjs")).outlookEvent,
  outlook_read: async () => (await import("./outlook.mjs")).outlookRead,
};

void run(async () => {
  const [command, ...rest] = process.argv.slice(2);
  const load = COMMANDS[String(command ?? "").replaceAll("-", "_")];
  if (!load)
    throw new ToolError(
      "USAGE",
      `Unknown command "${command ?? ""}"`,
      `Commands: ${Object.keys(COMMANDS).join(", ")}. Add --help after a command for its options.`,
    );
  await (await load())(rest);
});
