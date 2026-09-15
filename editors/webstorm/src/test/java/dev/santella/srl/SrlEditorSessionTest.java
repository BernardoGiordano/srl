package dev.santella.srl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.santella.srl.SrlEditorSession.Outcome;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * What a project is told when a file is opened in it. The assertions are project outcomes,
 * not resolved paths: silence, a message its owner can act on, or a started server.
 */
final class SrlEditorSessionTest {
  private static final String IN_REPOSITORY = "cli/language-server/server.mjs";
  private static final String INSTALLED = "node_modules/@srljs/cli/language-server/server.mjs";

  private final List<String> warnings = new ArrayList<>();
  private final List<String> errors = new ArrayList<>();
  private final List<String> starts = new ArrayList<>();
  private String node = "/opt/node/bin/node";
  private RuntimeException startFailure;

  @Test
  void startsTheServerTheProjectInstalls(@TempDir Path root) throws IOException {
    Path server = write(root, IN_REPOSITORY);
    assertEquals(Outcome.STARTED, open(session(root)));
    assertEquals(List.of("/opt/node/bin/node " + server), starts);
    assertEquals(List.of(), warnings);
    assertEquals(List.of(), errors);
  }

  @Test
  void prefersTheRepositoryCopyOverTheInstalledOne(@TempDir Path root) throws IOException {
    Path server = write(root, IN_REPOSITORY);
    write(root, INSTALLED);
    open(session(root));
    assertEquals(List.of("/opt/node/bin/node " + server), starts);
  }

  @Test
  void saysNothingAboutAProjectThatIsNotBuiltOnSrl(@TempDir Path root) throws IOException {
    Files.writeString(root.resolve("package.json"), "{\"dependencies\":{\"lit\":\"^3.0.0\"}}");
    assertEquals(Outcome.ABSENT, open(session(root)));
    assertEquals(List.of(), warnings);
    assertEquals(List.of(), errors);
    assertEquals(List.of(), starts);
  }

  @Test
  void saysNothingAboutADirectoryWithNoManifest(@TempDir Path root) {
    assertEquals(Outcome.ABSENT, open(session(root)));
    assertEquals(List.of(), warnings);
    assertEquals(List.of(), errors);
  }

  @Test
  void namesTheMissingToolchainWhenTheProjectAskedForSrl(@TempDir Path root) throws IOException {
    declareSrl(root, "devDependencies", "@srljs/cli");
    assertEquals(Outcome.REPORTED, open(session(root)));
    assertEquals(1, warnings.size());
    assertTrue(warnings.get(0).contains("Install the project's dependencies"), warnings.get(0));
    assertEquals(List.of(), starts);
  }

  @Test
  void readsEveryFieldADependencyCanBeDeclaredIn(@TempDir Path root) throws IOException {
    declareSrl(root, "peerDependencies", "@srljs/core");
    assertEquals(Outcome.REPORTED, open(session(root)));
    assertEquals(1, warnings.size());
  }

  @Test
  void treatsADirectoryCandidateAsNoServer(@TempDir Path root) throws IOException {
    declareSrl(root, "dependencies", "@srljs/cli");
    Files.createDirectories(root.resolve(IN_REPOSITORY));
    assertEquals(Outcome.REPORTED, open(session(root)));
    assertEquals(List.of(), starts);
  }

  @Test
  void reportsAMissingNodeRatherThanFailingToSpawn(@TempDir Path root) throws IOException {
    write(root, IN_REPOSITORY);
    node = null;
    assertEquals(Outcome.REPORTED, open(session(root)));
    assertEquals(1, errors.size());
    assertTrue(errors.get(0).contains("SRL_NODE_PATH"), errors.get(0));
    assertEquals(List.of(), starts);
  }

  @Test
  void startsOnceHoweverManyFilesAreOpened(@TempDir Path root) throws IOException {
    write(root, IN_REPOSITORY);
    SrlEditorSession session = session(root);
    assertEquals(Outcome.STARTED, open(session));
    assertEquals(Outcome.STARTED, open(session));
    assertEquals(Outcome.STARTED, open(session));
    assertEquals(1, starts.size());
  }

  @Test
  void saysTheSameThingOnce(@TempDir Path root) throws IOException {
    declareSrl(root, "dependencies", "@srljs/cli");
    SrlEditorSession session = session(root);
    open(session);
    open(session);
    open(session);
    assertEquals(1, warnings.size());
  }

  @Test
  void startsAfterTheDependenciesAreInstalled(@TempDir Path root) throws IOException {
    declareSrl(root, "dependencies", "@srljs/cli");
    SrlEditorSession session = session(root);
    assertEquals(Outcome.REPORTED, open(session));

    Path server = write(root, INSTALLED);
    assertEquals(Outcome.STARTED, open(session));
    assertEquals(List.of("/opt/node/bin/node " + server), starts);
    assertEquals(1, warnings.size());
  }

  @Test
  void retriesAfterAFailedStart(@TempDir Path root) throws IOException {
    write(root, IN_REPOSITORY);
    SrlEditorSession session = session(root);
    startFailure = new IllegalStateException("node is not executable");
    assertEquals(Outcome.REPORTED, open(session));
    assertEquals(1, errors.size());
    assertTrue(errors.get(0).contains("node is not executable"), errors.get(0));

    startFailure = null;
    assertEquals(Outcome.STARTED, open(session));
    assertEquals(2, starts.size(), "the failed attempt is retried, not remembered as running");
  }

  @Test
  void saysANewProblemAfterAnEarlierOne(@TempDir Path root) throws IOException {
    declareSrl(root, "dependencies", "@srljs/cli");
    SrlEditorSession session = session(root);
    open(session);
    write(root, IN_REPOSITORY);
    node = "";
    assertEquals(Outcome.REPORTED, open(session));
    assertEquals(1, warnings.size());
    assertEquals(1, errors.size());
  }

  @Test
  void forgetsWhatItStartedWhenDisposed(@TempDir Path root) throws IOException {
    write(root, IN_REPOSITORY);
    SrlEditorSession session = session(root);
    open(session);
    session.dispose();
    assertEquals(Outcome.STARTED, open(session));
    assertEquals(2, starts.size());
  }

  private SrlEditorSession session(Path root) {
    SrlEditorSession.Reporter reporter =
        new SrlEditorSession.Reporter() {
          @Override
          public void warn(String message) {
            warnings.add(message);
          }

          @Override
          public void error(String message) {
            errors.add(message);
          }
        };
    return new SrlEditorSession("app", root, SrlEditorSession.disk(), () -> node, reporter);
  }

  private Outcome open(SrlEditorSession session) {
    return session.opened(
        (executable, server) -> {
          starts.add(executable + " " + server);
          if (startFailure != null) throw startFailure;
        });
  }

  private static Path write(Path root, String relative) throws IOException {
    Path server = root.resolve(relative);
    Files.createDirectories(server.getParent());
    Files.writeString(server, "");
    return server;
  }

  private static void declareSrl(Path root, String field, String dependency) throws IOException {
    Files.writeString(
        root.resolve("package.json"),
        "{\n  \"name\": \"app\",\n  \"scripts\": { \"build\": \"srl build\" },\n  \""
            + field
            + "\": { \""
            + dependency
            + "\": \"0.9.0\" }\n}\n");
  }
}
