package dev.santella.srl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * What srl does for one open project: whether the project is ready, whether it has already
 * been told about a problem, and what starting the language server means.
 *
 * The replaced path-or-null lookup could not tell a project that is not built on srl from
 * one whose manifest asks for the toolchain and has none installed, so both were silence.
 * Readiness, the message a project gets at most once, and start policy live here instead of
 * around the file-open callback. ADR-0090.
 *
 * The disk, the notifications and the LSP starter are injected, so every outcome is driven
 * by a test without an IDE.
 */
final class SrlEditorSession {
  /** The disk the project lives on. */
  interface Filesystem {
    boolean isRegularFile(Path path);

    Optional<String> readString(Path path);
  }

  /** Where a project's problems are said. */
  interface Reporter {
    void warn(String message);

    void error(String message);
  }

  /** Starts the server. The platform hands a fresh starter to each file-open event. */
  interface ServerStarter {
    void start(String node, Path server) throws Exception;
  }

  /** What a project was told: nothing, a message it can act on, or a running server. */
  enum Outcome {
    STARTED,
    ABSENT,
    REPORTED
  }

  /** The toolchain copies this session starts, repository copy first to stay version-aligned. */
  private static final List<String> CANDIDATES =
      List.of(
          "cli/language-server/server.mjs",
          "node_modules/@srljs/cli/language-server/server.mjs");

  private static final List<String> DEPENDENCY_FIELDS =
      List.of("dependencies", "devDependencies", "peerDependencies", "optionalDependencies");

  private static final List<String> PACKAGES = List.of("\"@srljs/cli\"", "\"@srljs/core\"");

  private final String name;
  private final Path root;
  private final Filesystem files;
  private final Supplier<String> node;
  private final Reporter reporter;

  private boolean started;
  private String reported;

  SrlEditorSession(
      String name, Path root, Filesystem files, Supplier<String> node, Reporter reporter) {
    this.name = name;
    this.root = root;
    this.files = files;
    this.node = node;
    this.reporter = reporter;
  }

  /** The project directory the server is started in. */
  Path root() {
    return root;
  }

  /**
   * Serve this project. A project already served is left alone, and a project that is not
   * built on srl stays silent; the cases its owner can fix are said once each.
   *
   * Readiness is read on every open rather than cached: a later file open is this editor's
   * whole retry path after the dependencies are installed.
   */
  synchronized Outcome opened(ServerStarter starter) {
    if (started) return Outcome.STARTED;
    Path server = findServer();
    if (server == null) {
      if (!declaresSrl()) return Outcome.ABSENT;
      return report(
          false,
          "srl language server not found in "
              + name
              + ". Install the project's dependencies, then open an srl file again.");
    }
    String executable = node.get();
    if (executable == null || executable.isBlank()) {
      return report(
          true,
          "Node.js was not found for "
              + name
              + ". Install Node.js 22 or newer, or set SRL_NODE_PATH to its executable.");
    }
    try {
      starter.start(executable, server);
    } catch (Exception cause) {
      return report(true, "srl language server failed for " + name + ": " + describe(cause));
    }
    started = true;
    reported = null;
    return Outcome.STARTED;
  }

  /** Forget what was started, so a reopened project is decided again from scratch. */
  synchronized void dispose() {
    started = false;
    reported = null;
  }

  /** Say a message unless it is the one this project was last told. */
  private Outcome report(boolean failure, String message) {
    if (!message.equals(reported)) {
      reported = message;
      if (failure) reporter.error(message);
      else reporter.warn(message);
    }
    return Outcome.REPORTED;
  }

  private Path findServer() {
    for (String candidate : CANDIDATES) {
      Path server = root.resolve(candidate);
      if (files.isRegularFile(server)) return server;
    }
    return null;
  }

  /**
   * Whether the project's own manifest asks for srl. A project that names the packages and
   * has no server on disk has dependencies to install, which is worth saying; a project that
   * names neither is not an srl project and opening one HTML file in it is not a problem.
   */
  private boolean declaresSrl() {
    String manifest = files.readString(root.resolve("package.json")).orElse(null);
    if (manifest == null) return false;
    for (String field : DEPENDENCY_FIELDS) {
      String declared = objectAt(manifest, '"' + field + '"');
      if (declared != null && PACKAGES.stream().anyMatch(declared::contains)) return true;
    }
    return false;
  }

  /** The braces of the object a key holds, or null when the key is absent or holds anything else. */
  private static String objectAt(String manifest, String key) {
    int at = manifest.indexOf(key);
    if (at < 0) return null;
    int open = at + key.length();
    while (open < manifest.length()
        && (Character.isWhitespace(manifest.charAt(open)) || manifest.charAt(open) == ':')) {
      open++;
    }
    if (open >= manifest.length() || manifest.charAt(open) != '{') return null;
    int depth = 0;
    for (int i = open; i < manifest.length(); i++) {
      char character = manifest.charAt(i);
      if (character == '{') depth++;
      else if (character == '}' && --depth == 0) return manifest.substring(open, i + 1);
    }
    return null;
  }

  private static String describe(Exception cause) {
    String message = cause.getMessage();
    return message == null || message.isBlank() ? cause.getClass().getSimpleName() : message;
  }

  /** The real disk. */
  static Filesystem disk() {
    return new Filesystem() {
      @Override
      public boolean isRegularFile(Path path) {
        return Files.isRegularFile(path);
      }

      @Override
      public Optional<String> readString(Path path) {
        try {
          return Optional.of(Files.readString(path));
        } catch (IOException | RuntimeException cause) {
          return Optional.empty();
        }
      }
    };
  }
}
