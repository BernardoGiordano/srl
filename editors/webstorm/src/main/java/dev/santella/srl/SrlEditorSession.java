package dev.santella.srl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * Decide whether one project can start an srl language server. Injected disk,
 * notifications, and starter let tests cover each result without the IDE.
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

/** The last project status reported to the user. */
  enum Outcome {
    STARTED,
    ABSENT,
    REPORTED
  }

/** Candidate toolchain paths, with the project copy first. */
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
   * Start the server when this project is ready. Check again on each file open so
   * installing dependencies can make a previously missing server available.
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

/** Clear the last start decision when the project closes. */
  synchronized void dispose() {
    started = false;
    reported = null;
  }

/** Avoid repeating the same project message. */
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
   * Check whether the project's manifest declares srl.
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
