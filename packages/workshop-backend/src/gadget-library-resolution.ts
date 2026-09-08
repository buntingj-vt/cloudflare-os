/**
 * Resolving a gadget's library pins to code: the kernel half of src/gadget-libraries.ts, kept
 * apart from the grammar because it imports the generated bundles -- a good deal of code and
 * declarations the blueprint build scripts, which share the grammar, have no use for and must not
 * depend on existing (they are what produces it).
 */

import {
  GADGET_JSON_PATH,
  type GadgetPins,
  type LibrarySide,
  librarySpecifier,
  readPins,
} from "./gadget-libraries";
import { type BundledGadgetLibrary, GADGET_LIBRARIES } from "./generated/gadget-libraries";

/** One library module a gadget's pins resolve to, with the code and its content hash. */
export type ResolvedLibrary = {
  /** `gadgets:<name>/<side>`. */
  specifier: string;
  /** The ES module's source. */
  code: string;
  /** sha256 of `code`, hex: the UI's cache key, and what the loader logs for provenance. */
  hash: string;
};

/** The library the deployment ships under `name`, or undefined when it bundles none by that name. */
export function bundledLibrary(name: string): BundledGadgetLibrary | undefined {
  return GADGET_LIBRARIES.find(library => library.name === name);
}

/**
 * Identifies the set of bundles this deployment ships: the first sixteen hex digits of every
 * bundled hash, in name order. Part of the gadget loader's cache key, so an isolate cached before
 * a redeploy can never serve a `latest` pin the previous deployment's code.
 */
export const LIBRARIES_FINGERPRINT = GADGET_LIBRARIES
    .map(library => `${library.client.hash.slice(0, 16)}${library.server.hash.slice(0, 16)}`)
    .join(".");

/**
 * The modules one side of a gadget imports, in pin order: each `latest` pin is the deployment's
 * bundle. Throws when a pinned name is not bundled, so the gadget fails to load rather than run
 * without a library it asked for. Only the gadget's pins are consulted: a `gadgets:` import inside a
 * library resolves through the pins of the gadget loading it, so the gadget pins its libraries'
 * dependencies as well as its own -- a pin whose bundled dependency is unpinned is refused here with
 * the name to add.
 */
export function resolveLibraries(pins: GadgetPins, side: LibrarySide): ResolvedLibrary[] {
  const resolved: ResolvedLibrary[] = [];
  for (const [name] of pins) {
    const specifier = librarySpecifier(name, side);
    const library = bundledLibrary(name);
    if (!library) {
      throw new Error(`${GADGET_JSON_PATH} pins ${name} to latest, but this deployment ` +
          `bundles no library named ${name}.`);
    }
    for (const dependency of library.dependencies) {
      if (!pins.has(dependency)) {
        throw new Error(`${GADGET_JSON_PATH} pins ${name}, which imports ${dependency}; ` +
            `pin ${dependency} too.`);
      }
    }
    resolved.push({ specifier, code: library[side].code, hash: library[side].hash });
  }
  return resolved;
}

/**
 * The module map a gadget's Durable Object runs from: its own `.js` files under their paths, plus
 * the server side of every pinned library under the specifier the gadget imports it by. A library
 * wins over a same-named file, and workerd wants a typed module for a name that is not a `.js`
 * path. A pin that does not resolve throws, so the gadget fails to load like any broken one.
 */
export function gadgetWorkerModules(files: ReadonlyMap<string, string>)
    : {modules: WorkerLoaderWorkerCode["modules"], libraries: ResolvedLibrary[]} {
  const modules: WorkerLoaderWorkerCode["modules"] = {};
  for (const [file, content] of files) {
    if (file.endsWith(".js")) modules[file] = content;
  }
  const libraries = resolveLibraries(readPins(files), "server");
  for (const {specifier, code} of libraries) modules[specifier] = {js: code};
  return {modules, libraries};
}
