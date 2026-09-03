/* eslint-disable */
/**
 * Generated data model types.
 *
 * Normally produced by `npx convex dev` / `npx convex codegen`, which
 * requires an authenticated Convex project. Written by hand here so the
 * codebase type-checks before a deployment exists; `npx convex dev` will
 * regenerate and overwrite it, and the output should match.
 */

import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
} from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;

export type TableNames = TableNamesInDataModel<DataModel>;

export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;

export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;
