package dev.santella.srl;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Resolve the language server shipped by this repository or by the project's own @srljs/cli.
 * Using the project copy keeps the template grammar version-aligned. Free of IntelliJ types
 * so the resolution order is testable without an IDE, like editors/vscode/server-path.cjs.
 */
final class SrlServerLocator {
  private SrlServerLocator() {}

  static Path findServer(Path root) {
    Path[] candidates = {
      root.resolve("cli/language-server/server.mjs"),
      root.resolve("node_modules/@srljs/cli/language-server/server.mjs")
    };
    for (Path candidate : candidates) {
      if (Files.isRegularFile(candidate)) return candidate;
    }
    return null;
  }
}
