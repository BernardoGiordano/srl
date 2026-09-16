package dev.santella.srl;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.platform.lsp.api.LspServerSupportProvider;
import org.jetbrains.annotations.NotNull;

/**
 * Start the project's srl session when WebStorm opens a supported file.
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
