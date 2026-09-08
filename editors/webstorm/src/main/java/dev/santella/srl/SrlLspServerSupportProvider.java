package dev.santella.srl;

import com.intellij.execution.configurations.GeneralCommandLine;
import com.intellij.execution.configurations.PathEnvironmentVariableUtil;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.platform.lsp.api.LspServerSupportProvider;
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor;
import com.intellij.util.EnvironmentUtil;
import java.io.File;
import java.nio.file.Path;
import org.jetbrains.annotations.NotNull;

/** Starts the language server supplied by the srl toolchain installed in the project. */
public final class SrlLspServerSupportProvider implements LspServerSupportProvider {
  @Override
  public void fileOpened(
      @NotNull Project project,
      @NotNull VirtualFile file,
      @NotNull LspServerStarter serverStarter) {
    if (!isSupported(file)) return;
    Path root = projectRoot(project);
    if (root == null) return;
    Path server = SrlServerLocator.findServer(root);
    if (server == null) return;
    serverStarter.ensureServerStarted(new SrlServerDescriptor(project, root, server));
  }

  private static Path projectRoot(Project project) {
    String basePath = project.getBasePath();
    return basePath == null ? null : Path.of(basePath);
  }

  /**
   * A file the server can be told about: one that exists on disk. Files in archives, over
   * HTTP or in memory carry no path to send, and asking one for a path throws.
   */
  private static boolean isSupported(VirtualFile file) {
    if (!file.isInLocalFileSystem()) return false;
    String extension = file.getExtension();
    return "html".equals(extension) || "js".equals(extension) || "mjs".equals(extension);
  }

  /**
   * The Node.js that runs the server. Read through EnvironmentUtil rather than System.getenv
   * and PATH: a desktop-launched IDE inherits the launcher's environment, not the shell's, so
   * a version manager's node is invisible to the process and to a plain PATH lookup.
   */
  private static String nodeExecutable() {
    String configured = EnvironmentUtil.getValue("SRL_NODE_PATH");
    if (configured != null && !configured.isBlank()) return configured;
    // findFirst() supersedes findInPath() from 263 on, and does not exist in 261.
    File onPath = PathEnvironmentVariableUtil.findInPath("node");
    return onPath == null ? "node" : onPath.getAbsolutePath();
  }

  private static final class SrlServerDescriptor extends ProjectWideLspServerDescriptor {
    private final Path root;
    private final Path server;

    private SrlServerDescriptor(Project project, Path root, Path server) {
      super(project, "srl");
      this.root = root;
      this.server = server;
    }

    @Override
    public boolean isSupportedFile(@NotNull VirtualFile file) {
      return isSupported(file) && file.toNioPath().startsWith(root);
    }

    @Override
    public @NotNull GeneralCommandLine createCommandLine() {
      return new GeneralCommandLine(nodeExecutable(), server.toString())
          .withWorkingDirectory(root)
          .withEnvironment("SRL_ROOT", root.toString());
    }
  }
}
