package dev.santella.srl;

import com.intellij.execution.configurations.GeneralCommandLine;
import com.intellij.execution.configurations.PathEnvironmentVariableUtil;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.platform.lsp.api.LspServerSupportProvider;
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor;
import com.intellij.util.EnvironmentUtil;
import java.io.File;
import java.nio.file.Path;
import org.jetbrains.annotations.NotNull;

/**
 * The IntelliJ side of one project's srl session: the disk, the notification group, the
 * Node.js the server runs under and the platform's LSP starter. What those are used for is
 * {@link SrlEditorSession}, which this class holds one of per open project. ADR-0094.
 */
public final class SrlProjectSession implements Disposable {
  private final Project project;
  /** Null in a project with no base directory, which has nothing to serve. */
  private final SrlEditorSession session;

  public SrlProjectSession(@NotNull Project project) {
    this.project = project;
    String basePath = project.getBasePath();
    this.session =
        basePath == null
            ? null
            : new SrlEditorSession(
                project.getName(),
                Path.of(basePath),
                SrlEditorSession.disk(),
                SrlProjectSession::findNode,
                reporter(project));
  }

  void fileOpened(VirtualFile file, LspServerSupportProvider.LspServerStarter starter) {
    if (session == null || !isSupported(file)) return;
    Path root = session.root();
    session.opened(
        (node, server) ->
            starter.ensureServerStarted(new SrlServerDescriptor(project, root, node, server)));
  }

  @Override
  public void dispose() {
    if (session != null) session.dispose();
  }

  private static SrlEditorSession.Reporter reporter(Project project) {
    return new SrlEditorSession.Reporter() {
      @Override
      public void warn(String message) {
        show(project, message, NotificationType.WARNING);
      }

      @Override
      public void error(String message) {
        show(project, message, NotificationType.ERROR);
      }
    };
  }

  private static void show(Project project, String message, NotificationType type) {
    NotificationGroupManager.getInstance()
        .getNotificationGroup("srl")
        .createNotification(message, type)
        .notify(project);
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
   * The Node.js that runs the server, or null when none was found. Read through
   * EnvironmentUtil rather than System.getenv and PATH: a desktop-launched IDE inherits the
   * launcher's environment, not the shell's, so a version manager's node is invisible to the
   * process and to a plain PATH lookup.
   */
  private static String findNode() {
    String configured = EnvironmentUtil.getValue("SRL_NODE_PATH");
    if (configured != null && !configured.isBlank()) return configured;
    // findFirst() supersedes findInPath() from 263 on, and does not exist in 261.
    File onPath = PathEnvironmentVariableUtil.findInPath("node");
    return onPath == null ? null : onPath.getAbsolutePath();
  }

  private static final class SrlServerDescriptor extends ProjectWideLspServerDescriptor {
    private final Path root;
    private final String node;
    private final Path server;

    private SrlServerDescriptor(Project project, Path root, String node, Path server) {
      super(project, "srl");
      this.root = root;
      this.node = node;
      this.server = server;
    }

    @Override
    public boolean isSupportedFile(@NotNull VirtualFile file) {
      return isSupported(file) && file.toNioPath().startsWith(root);
    }

    @Override
    public @NotNull GeneralCommandLine createCommandLine() {
      return new GeneralCommandLine(node, server.toString())
          .withWorkingDirectory(root)
          .withEnvironment("SRL_ROOT", root.toString());
    }
  }
}
