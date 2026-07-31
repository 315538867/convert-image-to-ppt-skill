import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const defaultSchemaPath = path.join(packageRoot, "schema", "task-bundle.schema.json");
export const authoringTemplatePath = path.join(packageRoot, "examples", "task-bundle-example.json");
