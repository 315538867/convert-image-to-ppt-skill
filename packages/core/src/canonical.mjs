import { createHash } from "node:crypto";
import canonicalizeValue from "canonicalize";

const ARTIFACT_ID_RE = /^art_[0-9a-f]{64}$/;

export function canonicalize(value) {
  const result = canonicalizeValue(value);
  if (typeof result !== "string") throw new TypeError("输入不是 RFC 8785 可规范化的 JSON 值");
  return result;
}

export function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

export function sha256BytesDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function artifactIdFor(artifactWithoutId) {
  return `art_${sha256Digest(artifactWithoutId).slice("sha256:".length)}`;
}

export function bodyDigestFor(body) {
  return sha256Digest(body);
}

function resolveLocalRef(schema, rootSchema) {
  if (!schema?.$ref) return schema;
  if (!schema.$ref.startsWith("#/")) throw new Error(`不支持外部 Schema ref: ${schema.$ref}`);
  return schema.$ref.slice(2).split("/").reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], rootSchema);
}

function conditionMatches(value, condition, rootSchema) {
  const resolved = resolveLocalRef(condition, rootSchema);
  if (resolved.required && (!value || typeof value !== "object" || resolved.required.some((key) => !(key in value)))) return false;
  for (const [key, propertySchema] of Object.entries(resolved.properties ?? {})) {
    if (!value || !(key in value)) return false;
    const property = resolveLocalRef(propertySchema, rootSchema);
    if ("const" in property && value[key] !== property.const) return false;
    if (property.enum && !property.enum.includes(value[key])) return false;
  }
  return true;
}

export function collectArtifactRefs(artifact, rootSchema) {
  if (!rootSchema) throw new TypeError("collectArtifactRefs 必须接收权威 JSON Schema");
  const refs = new Set();

  function visit(value, schema, path = "$") {
    const resolved = resolveLocalRef(schema, rootSchema);
    if (!resolved || value === undefined) return;
    if (resolved["x-artifact-ref"] === true) {
      if (typeof value === "string" && ARTIFACT_ID_RE.test(value)) refs.add(value);
      return;
    }

    if (resolved.allOf) {
      for (const branch of resolved.allOf) {
        if (branch.if) {
          if (conditionMatches(value, branch.if, rootSchema) && branch.then) visit(value, branch.then, path);
        } else {
          visit(value, branch, path);
        }
      }
    }
    for (const branch of [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])]) {
      if (!branch.if && (!branch.properties || conditionMatches(value, branch, rootSchema))) visit(value, branch, path);
    }
    if (Array.isArray(value)) {
      if (resolved.items) value.forEach((item, index) => visit(item, resolved.items, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, childSchema] of Object.entries(resolved.properties ?? {})) {
        if (key in value) visit(value[key], childSchema, `${path}.${key}`);
      }
    }
  }

  visit(artifact, rootSchema.$defs.artifact);
  return [...refs].sort();
}

export function rewriteArtifactRefs(value, rootSchema, idMap) {
  if (!rootSchema) throw new TypeError("rewriteArtifactRefs 必须接收权威 JSON Schema");

  function rewrite(current, schema) {
    const resolved = resolveLocalRef(schema, rootSchema);
    if (!resolved || current === undefined) return current;
    if (resolved["x-artifact-ref"] === true) return typeof current === "string" ? (idMap.get(current) ?? current) : current;
    if (resolved.allOf) {
      for (const branch of resolved.allOf) {
        if (branch.if) {
          if (conditionMatches(current, branch.if, rootSchema) && branch.then) current = rewrite(current, branch.then);
        } else {
          current = rewrite(current, branch);
        }
      }
    }
    for (const branch of [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])]) {
      if (!branch.if && (!branch.properties || conditionMatches(current, branch, rootSchema))) current = rewrite(current, branch);
    }
    if (Array.isArray(current)) return resolved.items ? current.map((item) => rewrite(item, resolved.items)) : current;
    if (current && typeof current === "object") {
      const result = { ...current };
      for (const [key, childSchema] of Object.entries(resolved.properties ?? {})) {
        if (key in result) result[key] = rewrite(result[key], childSchema);
      }
      return result;
    }
    return current;
  }

  return rewrite(value, rootSchema.$defs.artifact);
}

export function artifactProjection(artifact) {
  const { artifactId: _artifactId, ...projection } = artifact;
  return projection;
}
