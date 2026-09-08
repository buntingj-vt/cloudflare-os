import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContent,
  extractFiles,
  parseArchive,
  readSourceFiles,
  serializeArchive,
} from "../scripts/format-blueprint-files.ts";
import {
  formatPins,
  librarySpecifier,
  parseLibrarySpecifier,
  parsePins,
  readPins,
} from "../src/gadget-libraries.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, {recursive: true, force: true})));
});

/** Writes `files` (archive-style relative paths) into a fresh temporary files/ tree. */
async function sourceTree(files: Record<string, string>): Promise<string> {
  let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
  temporaryDirectories.push(directory);
  for (let [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), {recursive: true});
    await writeFile(join(directory, path), source);
  }
  return directory;
}

describe("format blueprint source", () => {
  it("reconstructs files deterministically", () => {
    let files = new Map([
      ["server.js", "export default {};\n"],
      ["lib/util.js", "export const value = 1;\n"],
      ["empty.txt", ""],
      ["client.js", "console.log('hello');\n"],
    ]);
    let metadata = {
      title: "Example",
      description: "Example blueprint",
      author: {type: "user", name: "Test", id: "test@example.com"},
      created: "2026-01-01T00:00:00.000Z",
      version: 1,
      lastUpdated: "2026-01-01T00:00:00.000Z",
      bindings: {},
    };

    let first = serializeArchive(metadata, buildContent(files, "example"), "example");
    let second = serializeArchive(metadata, buildContent(files, "example"), "example");

    expect(second).toEqual(first);
    let parsed = parseArchive(first, "example");
    expect(parsed.metadata).toEqual(metadata);
    expect(extractFiles(parsed.content, "example")).toEqual(files);
  });

  it("reads nested source files as archive paths", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "lib"));
    await writeFile(join(directory, "client.js"), "client\n");
    await writeFile(join(directory, "lib/util.js"), "utility\n");

    expect(await readSourceFiles(directory, "example/files")).toEqual(new Map([
      ["client.js", "client\n"],
      ["lib/util.js", "utility\n"],
    ]));
  });

  it.each(["", "/client.js", "lib/", "lib//util.js", "lib/./util.js", "lib/../util.js",
    "lib\\util.js", "lib\0util.js"])("rejects unsafe archive path %j", path => {
    expect(() => buildContent(new Map([[path, "source"]]), "example"))
      .toThrow("unsafe blueprint file path");
  });

  it("rejects file and directory path conflicts", () => {
    expect(() => buildContent(new Map([["lib", "file"], ["lib/util.js", "nested"]]), "example"))
      .toThrow("lib/util.js conflicts with file lib");
  });

  it.each([
    ["Foo.js", "foo.js"],
    ["caf\u00e9.js", "cafe\u0301.js"],
    ["\u03a3.js", "\u03c2.js"],
    ["S.js", "\u017f.js"],
    ["\u00df.js", "\u1e9e.js"],
  ])("rejects filesystem-equivalent archive paths %j and %j", (first, second) => {
    expect(() => buildContent(new Map([[first, "first"], [second, "second"]]), "example"))
      .toThrow("aliases");
  });

  it("rejects filesystem-equivalent file and directory conflicts", () => {
    expect(() => buildContent(new Map([["LIB", "file"], ["lib/util.js", "nested"]]), "example"))
      .toThrow("lib/util.js conflicts with file LIB");
  });

  it("rejects filesystem-equivalent directory aliases", () => {
    expect(() => buildContent(new Map([
      ["Foo/first.js", "first"],
      ["foo/second.js", "second"],
    ]), "example")).toThrow("foo aliases directory Foo");
  });

  it("rejects portable file and directory conflicts", () => {
    expect(() => buildContent(new Map([
      ["Foo", "file"],
      ["foo/child.js", "child"],
    ]), "example")).toThrow("foo/child.js conflicts with file Foo");
    expect(() => buildContent(new Map([
      ["foo/child.js", "child"],
      ["Foo", "file"],
    ]), "example")).toThrow("Foo conflicts with directory foo");
  });

  it.each(["CON", "aux.js", "COM\u00b9.log", "a:b.js", "client.js.", "client.js ",
    ".git/config", ".gitignore"])("rejects non-portable archive path %j", path => {
    expect(() => buildContent(new Map([[path, "source"]]), "example"))
      .toThrow("non-portable blueprint file path");
  });

  it("rejects empty blueprints", () => {
    expect(() => buildContent(new Map(), "example"))
      .toThrow("blueprint must contain at least one source file");
  });

  it("preserves a leading UTF-8 BOM", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "client.js"),
      Uint8Array.of(0xef, 0xbb, 0xbf, 0x73, 0x6f, 0x75, 0x72, 0x63, 0x65));

    expect((await readSourceFiles(directory, "example/files")).get("client.js"))
      .toBe("\ufeffsource");
  });

  it("rejects non-UTF-8 source", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "client.js"), Uint8Array.of(0xff));

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("client.js is not valid UTF-8");
  });

  it("rejects symlinks", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "source.js"), "source");
    await symlink(join(directory, "source.js"), join(directory, "client.js"));

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("client.js must not be a symlink");
  });

  it("rejects nested directory symlinks", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    let outside = await mkdtemp(join(tmpdir(), "format-blueprint-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.js"), "secret");
    await symlink(outside, join(directory, "lib"));

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("lib must not be a symlink");
  });

  it("rejects a symlink used as the source root", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    let link = `${directory}-link`;
    temporaryDirectories.push(link);
    await symlink(directory, link);

    await expect(readSourceFiles(link, "example/files"))
      .rejects.toThrow("example/files: must not be a symlink");
  });
});

describe("format blueprint library pins", () => {
  const SYNC_PINS = '{"libraries": {"sync": "latest"}}\n';

  it("passes a blueprint whose imports and pins agree", async () => {
    let directory = await sourceTree({
      "client.js": 'import { SaveScheduler } from "gadgets:sync/client";\nvoid SaveScheduler;\n',
      "server.js": 'export { MutationQueue } from "gadgets:sync/server";\n',
      "gadget.json": SYNC_PINS,
    });

    expect(await readSourceFiles(directory, "example/files")).toEqual(new Map([
      ["client.js", 'import { SaveScheduler } from "gadgets:sync/client";\nvoid SaveScheduler;\n'],
      ["gadget.json", SYNC_PINS],
      ["server.js", 'export { MutationQueue } from "gadgets:sync/server";\n'],
    ]));
  });

  it("rejects a library import gadget.json does not pin", async () => {
    let directory = await sourceTree({
      "client.js": 'import { el } from "gadgets:ui/client";\nel("div");\n',
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow("example/files: client.js imports gadgets:ui/client, which gadget.json does " +
          "not pin");
  });

  it("names the module that wrote an unpinned import, not just the entry", async () => {
    let directory = await sourceTree({
      "client.js": 'import { mount } from "./lib/mount.js";\nmount();\n',
      "lib/mount.js": 'export { el as mount } from "gadgets:ui/client";\n',
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow("lib/mount.js imports gadgets:ui/client, which gadget.json does not pin");
  });

  it("scans specifiers as text, comments included", async () => {
    let directory = await sourceTree({
      "client.js": '// TODO: import { el } from "gadgets:ui/client";\nexport {};\n',
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow("client.js imports gadgets:ui/client, which gadget.json does not pin");
  });

  it("ignores a library import in a file no entry reaches", async () => {
    let directory = await sourceTree({
      "client.js": "export {};\n",
      "notes/scratch.js": 'import { el } from "gadgets:ui/client";\n',
    });

    expect([...(await readSourceFiles(directory, "example/files")).keys()])
      .toEqual(["client.js", "notes/scratch.js"]);
  });

  it("rejects a pin nothing imports", async () => {
    let directory = await sourceTree({
      "client.js": "export {};\n",
      "gadget.json": SYNC_PINS,
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("example/files: gadget.json pins sync, which nothing imports");
  });

  it("rejects a pin only a file no entry reaches imports", async () => {
    let directory = await sourceTree({
      "client.js": "export {};\n",
      "notes/scratch.js": 'import { SaveScheduler } from "gadgets:sync/client";\n',
      "gadget.json": SYNC_PINS,
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("gadget.json pins sync, which nothing imports");
  });

  it.each([
    ["client", "server"],
    ["server", "client"],
  ] as const)("rejects %s.js importing a library's %s side", async (entry, side) => {
    let directory = await sourceTree({
      [`${entry}.js`]: `import * as sync from "gadgets:sync/${side}";\nexport default sync;\n`,
      "gadget.json": SYNC_PINS,
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow(`example/files: ${entry}.js imports gadgets:sync/${side} from the ${entry} side`);
  });

  it("checks each side's imports from its own entry", async () => {
    // The same library, imported by both entries: each side is walked from its own entry, so
    // neither import is mistaken for the other side's.
    let directory = await sourceTree({
      "client.js": 'import "gadgets:sync/client";\n',
      "server.js": 'import "gadgets:sync/server";\n',
      "gadget.json": SYNC_PINS,
    });

    expect((await readSourceFiles(directory, "example/files")).size).toBe(3);
  });

  it("rejects a pinned import of a library the deployment does not bundle", async () => {
    let files = {
      "client.js": 'import { mount } from "gadgets:other/client";\nmount();\n',
      "gadget.json": '{"libraries": {"other": "latest"}}\n',
    };

    await expect(readSourceFiles(await sourceTree(files), "example/files",
        {libraries: new Map([["sync", []]])})).rejects
      .toThrow("example/files: client.js imports gadgets:other/client, but the deployment " +
          "bundles no library named other");
    // Without the set -- the archive tests, an importer that only needs the files -- names are
    // taken on trust.
    expect((await readSourceFiles(await sourceTree(files), "example/files")).size).toBe(2);
    expect((await readSourceFiles(await sourceTree(files), "example/files",
        {libraries: new Map([["other", []], ["sync", []]])})).size).toBe(2);
  });

  it("demands the pins of what an imported library imports in turn", async () => {
    const files = {
      "client.js": 'import { mount } from "gadgets:page/client"; mount();',
      "server.js": "export default {};",
    };
    const libraries = new Map([["page", ["ui"]], ["ui", []]]);
    await expect(readSourceFiles(await sourceTree({
      ...files, "gadget.json": '{"libraries": {"page": "latest"}}',
    }), "example/files", {libraries})).rejects
      .toThrow("example/files: gadget.json must also pin ui, which the page library imports");
    const output = await readSourceFiles(await sourceTree({
      ...files, "gadget.json": '{"libraries": {"page": "latest", "ui": "latest"}}',
    }), "example/files", {libraries});
    expect(output.has("gadget.json")).toBe(true);
  });

  it.each([
    ["not JSON", "{libraries: {}}", /gadget\.json: not valid JSON \(/u],
    ["an array", "[]", "gadget.json: must be an object"],
    ["an unknown key", '{"libraries": {"sync": "latest"}, "version": 1}',
      "gadget.json: unknown keys: version"],
    ["a libraries list", '{"libraries": ["sync"]}',
      "gadget.json: libraries must be an object of library name to pin"],
    ["a bad pin", '{"libraries": {"sync": "1.0.0"}}',
      'gadget.json: libraries.sync must be "latest"'],
    ["a vendored pin", '{"libraries": {"sync": "vendored"}}',
      'gadget.json: libraries.sync must be "latest"'],
    ["a bad library name", '{"libraries": {"Sync": "latest"}}',
      'gadget.json: "Sync" is not a library name ([a-z][a-z0-9-]*)'],
  ])("rejects a gadget.json that is %s", async (_case, text, message) => {
    let directory = await sourceTree({
      "client.js": 'import { SaveScheduler } from "gadgets:sync/client";\nvoid SaveScheduler;\n',
      "gadget.json": text,
    });

    await expect(readSourceFiles(directory, "example/files")).rejects.toThrow(message);
    await expect(readSourceFiles(directory, "example/files")).rejects.toThrow(/^example\/files: /u);
  });

  it.each(["gadgets:sync", "gadgets:sync/lib", "gadgets:sync/client/index.js",
    "gadgets:Sync/client", "gadgets:/client"])(
    "rejects %s, which is not a library specifier", async specifier => {
      let directory = await sourceTree({
        "client.js": `import * as sync from "${specifier}";\nexport default sync;\n`,
        "gadget.json": SYNC_PINS,
      });

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow(`example/files: client.js imports ${specifier}, which is not a library ` +
            "(gadgets:<name>/client or gadgets:<name>/server)");
    });
});

describe("gadget library grammar", () => {
  it("spells and parses a library specifier", () => {
    expect(librarySpecifier("sync", "client")).toBe("gadgets:sync/client");
    expect(parseLibrarySpecifier("gadgets:sync/client")).toEqual({name: "sync", side: "client"});
    expect(parseLibrarySpecifier("gadgets:my-lib2/server"))
      .toEqual({name: "my-lib2", side: "server"});
  });

  it.each(["gadgets:sync", "gadgets:sync/lib", "gadgets:sync/client/", "gadgets:a/b/client",
    "gadgets:Sync/client", "gadgets:2sync/client", "gadgets:-sync/client", "gadgets:/client",
    "gadgets:sync/CLIENT", " gadgets:sync/client", "gadget:sync/client", "./gadgets:sync/client",
    ""])("parses %j as no library specifier", specifier => {
    expect(parseLibrarySpecifier(specifier)).toBeNull();
  });

  it("reads no pins from an absent or empty gadget.json", () => {
    expect(readPins(new Map([["client.js", "export {};"]]))).toEqual(new Map());
    expect(parsePins("{}")).toEqual(new Map());
    expect(parsePins('{"libraries": {}}')).toEqual(new Map());
  });

  it("reads pins through the file map", () => {
    expect(readPins(new Map([["gadget.json", '{"libraries": {"sync": "latest"}}']])))
      .toEqual(new Map([["sync", "latest"]]));
  });

  it("formats pins sorted, in the shape the repo's blueprints commit", () => {
    let text = formatPins(new Map([["zeta", "latest"], ["alpha", "latest"]]));

    expect(text).toBe([
      "{",
      '  "libraries": {',
      '    "alpha": "latest",',
      '    "zeta": "latest"',
      "  }",
      "}",
      "",
    ].join("\n"));
    expect(parsePins(text)).toEqual(new Map([["alpha", "latest"], ["zeta", "latest"]]));
    expect(formatPins(new Map())).toBe('{\n  "libraries": {}\n}\n');
  });

  it.each([
    ["{libraries: {}}", /^gadget\.json: not valid JSON \(/u],
    ["null", "gadget.json: must be an object"],
    ['"sync"', "gadget.json: must be an object"],
    ["[]", "gadget.json: must be an object"],
    ['{"pins": {}}', "gadget.json: unknown keys: pins"],
    ['{"libraries": null}', "gadget.json: libraries must be an object of library name to pin"],
    ['{"libraries": "sync"}', "gadget.json: libraries must be an object of library name to pin"],
    ['{"libraries": {"sync": "Latest"}}', 'gadget.json: libraries.sync must be "latest"'],
    ['{"libraries": {"sync": true}}', 'gadget.json: libraries.sync must be "latest"'],
    ['{"libraries": {"my lib": "latest"}}',
      'gadget.json: "my lib" is not a library name ([a-z][a-z0-9-]*)'],
    ['{"libraries": {"": "latest"}}', 'gadget.json: "" is not a library name ([a-z][a-z0-9-]*)'],
  ])("rejects malformed pin file %s", (text, message) => {
    expect(() => parsePins(text)).toThrow(message);
  });
});
