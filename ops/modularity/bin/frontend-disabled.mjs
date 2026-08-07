#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { frontendDisabled } from "./plugout.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const id = process.argv[2];
if (!id) throw new Error("Usage: frontend-disabled.mjs <module-id>");
frontendDisabled(repositoryRoot, id);
