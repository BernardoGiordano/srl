package dev.santella.srl;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.platform.lsp.api.LspServerSupportProvider;
import org.jetbrains.annotations.NotNull;

/**
 * The WebStorm half of ADR-0090's thin launcher: it turns a file-open event into one
 * project's session. Which files count, when a server may start and what a project is told
 * are {@link SrlProjectSession} and {@link SrlEditorSession}. ADR-0094.
 */
public final class SrlLspServerSupportProvider implements LspServerSupportProvider {
  @Override
  public void fileOpened(
      @NotNull Project project,
      @NotNull VirtualFile file,
      @NotNull LspServerStarter serverStarter) {
    SrlProjectSession session = project.getService(SrlProjectSession.class);
    if (session != null) session.fileOpened(file, serverStarter);
  }
}
