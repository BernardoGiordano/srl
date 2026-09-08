package dev.santella.srl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The candidate order both editor clients resolve; the VS Code side covers it in JavaScript. */
final class SrlServerLocatorTest {
  private static final String IN_REPOSITORY = "cli/language-server/server.mjs";
  private static final String INSTALLED = "node_modules/@srljs/cli/language-server/server.mjs";

  @Test
  void findsTheServerInsideThisRepository(@TempDir Path root) throws IOException {
    Path server = write(root, IN_REPOSITORY);
    assertEquals(server, SrlServerLocator.findServer(root));
  }

  @Test
  void findsTheServerInstalledFromTheRegistry(@TempDir Path root) throws IOException {
    Path server = write(root, INSTALLED);
    assertEquals(server, SrlServerLocator.findServer(root));
  }

  @Test
  void prefersTheRepositoryCopyOverTheInstalledOne(@TempDir Path root) throws IOException {
    Path server = write(root, IN_REPOSITORY);
    write(root, INSTALLED);
    assertEquals(server, SrlServerLocator.findServer(root));
  }

  @Test
  void findsNothingInAProjectWithoutTheToolchain(@TempDir Path root) {
    assertNull(SrlServerLocator.findServer(root));
  }

  @Test
  void ignoresACandidateThatIsADirectory(@TempDir Path root) throws IOException {
    Files.createDirectories(root.resolve(IN_REPOSITORY));
    assertNull(SrlServerLocator.findServer(root));
  }

  private static Path write(Path root, String relative) throws IOException {
    Path server = root.resolve(relative);
    Files.createDirectories(server.getParent());
    Files.writeString(server, "");
    return server;
  }
}
