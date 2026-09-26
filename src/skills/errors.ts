import { UmioError } from "../errors.js";
import type { SkillDiagnostic } from "./types.js";

/** Base class of skill errors. */
export class SkillError extends UmioError {}

/** The catalog has invalid packages; `diagnostics` lists every problem found. */
export class SkillCatalogError extends SkillError {
  constructor(readonly diagnostics: readonly SkillDiagnostic[]) {
    super(
      `Invalid skill catalog:\n${diagnostics
        .map((item) => `  - ${item.path}${item.field ? ` (${item.field})` : ""}: ${item.message}`)
        .join("\n")}`,
    );
  }
}

/** A selection names a skill that is not in the catalog, or activates one it does not include. */
export class SkillSelectionError extends SkillError {}

/** A document or resource differs from the digest recorded earlier. */
export class SkillChangedError extends SkillError {}

/** A preparation or read would exceed a `SkillLimits` bound. */
export class SkillLimitError extends SkillError {}
