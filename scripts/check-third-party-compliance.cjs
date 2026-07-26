#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const cargoCommand = process.platform === "win32" ? "cargo.exe" : "cargo";
const gitCommand = process.platform === "win32" ? "git.exe" : "git";
const requiredNoticeFiles = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];
const unresolvedLicensePattern = /^(?:NOASSERTION|NONE)$/i;
const nonStandardLicensePattern = /SEE\s+LICENSE|LicenseRef-|UNLICENSED|PROPRIETARY/i;
const reviewableLicensePointerPattern = /SEE\s+LICENSE/i;
const reviewLicensePattern =
  /(?:^|[^A-Za-z])(?:A?GPL|LGPL|MPL|EPL|CDDL|SSPL|BUSL|BSL|EUPL|OSL)(?:-|$)|PolyForm|Commons-Clause/i;

function parseArguments(argv) {
  let outputDirectory;
  let strict = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") {
      strict = true;
      continue;
    }
    if (argument === "--output") {
      outputDirectory = argv[index + 1];
      if (!outputDirectory) {
        throw new Error("--output requires a directory");
      }
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/check-third-party-compliance.cjs " +
          "[--strict] [--output <directory>]",
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { outputDirectory, strict };
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .replaceAll(repositoryRoot, "<repository>")
      .replaceAll(os.homedir(), "<home>")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}` +
        (details ? `\n${details}` : ""),
    );
  }
  return result.stdout;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(outputDirectory, fileName, value) {
  fs.writeFileSync(
    path.join(outputDirectory, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function isUnresolvedLicense(license) {
  return (
    !license || unresolvedLicensePattern.test(license) || nonStandardLicensePattern.test(license)
  );
}

function packageIdentity(entry) {
  return `${entry.name}@${entry.version}`;
}

function reviewKey(entry) {
  return [entry.ecosystem, entry.project, packageIdentity(entry), entry.license].join(":");
}

function verifyInstalledLicensePointer(entry, npmProjects) {
  const pointer = /^SEE\s+LICENSE\s+IN\s+(.+)$/i.exec(entry.license)?.[1]?.trim();
  if (!pointer || pointer !== path.basename(pointer)) {
    throw new Error("license pointer is not a safe file name");
  }

  const project = npmProjects.find((candidate) => candidate.name === entry.project);
  if (!project) {
    throw new Error("npm project is unavailable");
  }

  const packageDirectory = path.join(
    project.directory,
    "node_modules",
    ...entry.name.split("/"),
  );
  if (!fs.existsSync(packageDirectory)) {
    // npm omits optional packages for other operating systems and architectures.
    return;
  }

  const evidencePath = path.join(packageDirectory, pointer);
  let evidence;
  try {
    evidence = fs.lstatSync(evidencePath);
  } catch {
    throw new Error("referenced license file is missing");
  }
  if (!evidence.isFile() || evidence.size === 0 || evidence.size > 1024 * 1024) {
    throw new Error("referenced license file is not a bounded regular file");
  }
}

function inspectSpdxDocument(document, project, scope) {
  const described = new Set(document.documentDescribes || []);
  return (document.packages || [])
    .filter((entry) => !described.has(entry.SPDXID))
    .map((entry) => ({
      ecosystem: "npm",
      project,
      scope,
      name: entry.name,
      version: entry.versionInfo || "unknown",
      license: entry.licenseDeclared || "NOASSERTION",
      downloadLocation: entry.downloadLocation || "NOASSERTION",
    }))
    .sort((left, right) => packageIdentity(left).localeCompare(packageIdentity(right)));
}

function makeSpdxId(name, version, index) {
  const safeName = `${name}-${version}`.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `SPDXRef-Package-${safeName || "unknown"}-${index}`;
}

function cargoPurl(name, version) {
  return `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function createCargoSpdx(metadata, createdAt, commit) {
  const idByCargoId = new Map();
  const packages = metadata.packages.map((entry, index) => {
    const spdxId = makeSpdxId(entry.name, entry.version, index);
    idByCargoId.set(entry.id, spdxId);
    return {
      SPDXID: spdxId,
      name: entry.name,
      versionInfo: entry.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: entry.license || "NOASSERTION",
      copyrightText: "NOASSERTION",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: cargoPurl(entry.name, entry.version),
        },
      ],
    };
  });

  const relationships = [];
  const rootId = metadata.resolve?.root ? idByCargoId.get(metadata.resolve.root) : undefined;
  if (rootId) {
    relationships.push({
      spdxElementId: "SPDXRef-DOCUMENT",
      relatedSpdxElement: rootId,
      relationshipType: "DESCRIBES",
    });
  }

  for (const node of metadata.resolve?.nodes || []) {
    const parentId = idByCargoId.get(node.id);
    if (!parentId) continue;
    for (const dependency of node.deps || []) {
      const dependencyId = idByCargoId.get(dependency.pkg);
      if (!dependencyId) continue;
      const kinds = new Set((dependency.dep_kinds || []).map((entry) => entry.kind || "normal"));
      let relationshipType = "DEPENDENCY_OF";
      if (kinds.size > 0 && [...kinds].every((kind) => kind === "dev")) {
        relationshipType = "DEV_DEPENDENCY_OF";
      } else if (kinds.size > 0 && [...kinds].every((kind) => kind === "build")) {
        relationshipType = "BUILD_DEPENDENCY_OF";
      }
      relationships.push({
        spdxElementId: dependencyId,
        relatedSpdxElement: parentId,
        relationshipType,
      });
    }
  }

  const namespaceSuffix = crypto
    .createHash("sha256")
    .update(`${commit}:${createdAt}`)
    .digest("hex")
    .slice(0, 24);

  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "bytro-community-cargo",
    documentNamespace: `https://bytro-community.invalid/spdx/cargo/${namespaceSuffix}`,
    creationInfo: {
      created: createdAt,
      creators: [
        "Tool: scripts/check-third-party-compliance.cjs",
        "Organization: Bytro Community Edition contributors",
      ],
    },
    documentDescribes: rootId ? [rootId] : [],
    packages,
    relationships,
  };
}

function verifyNoticePackaging() {
  for (const fileName of requiredNoticeFiles) {
    const filePath = path.join(repositoryRoot, fileName);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      throw new Error(`Required notice file is missing or empty: ${fileName}`);
    }
  }

  const notices = fs.readFileSync(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const requiredText of [
    "Copyright (c) 2026 Julius Brussee",
    "https://github.com/JuliusBrussee/caveman",
    "Permission is hereby granted, free of charge",
  ]) {
    if (!notices.includes(requiredText)) {
      throw new Error(
        `THIRD_PARTY_NOTICES.md is missing required Caveman notice text: ` + requiredText,
      );
    }
  }

  const tauriConfig = readJson(path.join(repositoryRoot, "src-tauri", "tauri.conf.json"));
  const resources = tauriConfig.bundle?.resources || {};
  for (const fileName of requiredNoticeFiles) {
    if (resources[`../${fileName}`] !== fileName) {
      throw new Error(`src-tauri/tauri.conf.json must bundle ../${fileName} as ${fileName}`);
    }
  }
}

function main() {
  const { outputDirectory: requestedOutput, strict } = parseArguments(process.argv.slice(2));
  const outputDirectory = requestedOutput
    ? path.resolve(repositoryRoot, requestedOutput)
    : fs.mkdtempSync(path.join(os.tmpdir(), "bytro-compliance-"));
  fs.mkdirSync(outputDirectory, { recursive: true });

  const createdAt = new Date().toISOString();
  const failures = [];
  const inventory = [];
  const runtimeEntries = [];
  const buildOnlyUnresolved = [];
  const manualReview = [];
  const npmProjects = [
    { name: "frontend", directory: repositoryRoot },
    { name: "sidecar", directory: path.join(repositoryRoot, "sidecar") },
    {
      name: "site-preview-worker",
      directory: path.join(repositoryRoot, "services", "site-preview-worker"),
    },
  ];

  let commit = "working-tree";
  try {
    commit = runCommand(gitCommand, ["rev-parse", "HEAD"], repositoryRoot).trim();
  } catch {
    // A source archive may not contain Git metadata.
  }

  try {
    verifyNoticePackaging();
  } catch (error) {
    failures.push(error.message);
  }

  for (const project of npmProjects) {
    try {
      const allText = runCommand(npmCommand, ["sbom", "--sbom-format", "spdx"], project.directory);
      const runtimeText = runCommand(
        npmCommand,
        ["sbom", "--package-lock-only", "--omit", "dev", "--sbom-format", "spdx"],
        project.directory,
      );
      const allDocument = JSON.parse(allText);
      const runtimeDocument = JSON.parse(runtimeText);
      writeJson(outputDirectory, `npm-${project.name}-all.spdx.json`, allDocument);
      writeJson(outputDirectory, `npm-${project.name}-runtime.spdx.json`, runtimeDocument);

      const allEntries = inspectSpdxDocument(allDocument, project.name, "all");
      const resolvedLicenseByIdentity = new Map(
        allEntries
          .filter((entry) => !isUnresolvedLicense(entry.license))
          .map((entry) => [packageIdentity(entry), entry.license]),
      );
      const projectRuntimeEntries = inspectSpdxDocument(
        runtimeDocument,
        project.name,
        "runtime",
      ).map((entry) => {
        if (!isUnresolvedLicense(entry.license)) {
          return entry;
        }
        const resolvedLicense = resolvedLicenseByIdentity.get(packageIdentity(entry));
        return resolvedLicense ? { ...entry, license: resolvedLicense } : entry;
      });
      const runtimeIdentities = new Set(projectRuntimeEntries.map(packageIdentity));

      inventory.push(...allEntries);
      runtimeEntries.push(...projectRuntimeEntries);
      for (const entry of allEntries) {
        if (!runtimeIdentities.has(packageIdentity(entry)) && isUnresolvedLicense(entry.license)) {
          buildOnlyUnresolved.push({
            ...entry,
            reason: "Build/development dependency has an unresolved license",
          });
        }
      }
    } catch (error) {
      failures.push(`${project.name}: ${error.message}`);
    }
  }

  try {
    const metadataText = runCommand(
      cargoCommand,
      ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--format-version", "1"],
      repositoryRoot,
    );
    const metadata = JSON.parse(metadataText);
    const cargoSpdx = createCargoSpdx(metadata, createdAt, commit);
    writeJson(outputDirectory, "cargo-runtime.spdx.json", cargoSpdx);

    const cargoEntries = metadata.packages
      .map((entry) => ({
        ecosystem: "cargo",
        project: "src-tauri",
        scope: "runtime",
        name: entry.name,
        version: entry.version,
        license: entry.license || "NOASSERTION",
        downloadLocation: entry.repository || "NOASSERTION",
      }))
      .sort((left, right) => packageIdentity(left).localeCompare(packageIdentity(right)));
    inventory.push(...cargoEntries);
    runtimeEntries.push(...cargoEntries);
  } catch (error) {
    failures.push(`cargo: ${error.message}`);
  }

  const policyPath = path.join(repositoryRoot, "scripts", "third-party-license-policy.json");
  try {
    const policy = readJson(policyPath);
    if (
      policy.schemaVersion !== 1 ||
      !Array.isArray(policy.approvedRuntimeReview) ||
      policy.approvedRuntimeReview.some((entry) => typeof entry !== "string")
    ) {
      throw new Error("unsupported policy schema");
    }
    const approved = new Set(policy.approvedRuntimeReview);

    for (const entry of runtimeEntries) {
      if (isUnresolvedLicense(entry.license)) {
        const key = reviewKey(entry);
        if (reviewableLicensePointerPattern.test(entry.license) && approved.has(key)) {
          try {
            verifyInstalledLicensePointer(entry, npmProjects);
          } catch (error) {
            failures.push(`Invalid approved runtime license evidence: ${key}: ${error.message}`);
          }
          continue;
        }
        failures.push(`Unresolved runtime license: ${key}`);
        continue;
      }
      if (reviewLicensePattern.test(entry.license)) {
        const key = reviewKey(entry);
        if (!approved.has(key)) {
          manualReview.push({
            ...entry,
            key,
            reason: "Runtime license requires explicit distribution review",
          });
        }
      }
    }
  } catch (error) {
    failures.push(`license policy: ${error.message}`);
  }

  manualReview.push(...buildOnlyUnresolved);
  if (strict && manualReview.length > 0) {
    failures.push(`${manualReview.length} license review item(s) remain unresolved`);
  }
  inventory.sort((left, right) =>
    [left.ecosystem, left.project, left.name, left.version, left.scope]
      .join(":")
      .localeCompare(
        [right.ecosystem, right.project, right.name, right.version, right.scope].join(":"),
      ),
  );

  writeJson(outputDirectory, "license-inventory.json", inventory);
  writeJson(outputDirectory, "manual-review.json", manualReview);
  writeJson(outputDirectory, "summary.json", {
    generatedAt: createdAt,
    commit,
    strict,
    requiredNoticeFiles,
    inventoryEntries: inventory.length,
    runtimeEntries: runtimeEntries.length,
    manualReviewEntries: manualReview.length,
    failures,
  });

  console.log(`Compliance artifacts: ${outputDirectory}`);
  console.log(`Inventory: ${inventory.length}; manual review: ${manualReview.length}`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[compliance] ${failure}`);
    }
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`[compliance] ${error.message}`);
  process.exitCode = 1;
}
