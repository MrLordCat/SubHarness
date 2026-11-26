# Interactive Debian desktop in Docker

This runs the Microsoft VS Code desktop application in Debian 12 with XFCE.
noVNC displays the desktop in a browser. SubHarness is not preinstalled,
so the VSIX installation and subsequent reloads can be tested manually.

## Start on Windows / Docker Desktop

Build the GUI image from the repository:

```powershell
docker build -f Dockerfile.gui -t ai-agent-bridge-debian-gui .
```

Use the Linux x64 VSIX from the latest release. The file is named
`llama-vscode-chat-<version>-linux-x64.vsix`; replace `<version>` below with the
downloaded version:

```powershell
$version = "<version>"
$vsix = (Resolve-Path ".\llama-vscode-chat-${version}-linux-x64.vsix").Path
docker run -d --name ai-agent-bridge-debian-gui --shm-size=1g `
  -p 127.0.0.1:6080:6080 `
  --mount "type=volume,source=ai-agent-bridge-debian-gui-home,target=/home/node" `
   --mount "type=bind,source=$vsix,target=/packages/llama-vscode-chat-${version}-linux-x64.vsix,readonly" `
  ai-agent-bridge-debian-gui
```

Open [the Debian desktop](http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale).
The port is bound only to the Windows loopback address.

The desktop runs as UID 1000. Files, profiles, accounts and installed extensions
under `/home/node` persist in the named Docker volume. Windows accounts and
credential folders are not mounted.

## Install and check the extension

1. In VS Code, open **Extensions** and its **…** menu.
2. Choose **Install from VSIX…** and select
   `/packages/llama-vscode-chat-<version>-linux-x64.vsix`.
3. Run **Developer: Reload Window**.
4. Open the SubHarness chat in the secondary side bar. The SubHarness icon in
   the activity bar opens Quick Access, the control tree.
5. Configure the provider you want to test. Firefox is available for account
   sign-in and OAuth callbacks inside the container.

Use the noVNC sidebar's clipboard panel to paste text. Alt+Shift switches the
US/Russian keyboard layout. The desktop contains a short README and a shortcut
to the mounted VSIX folder.

A model server running on Windows is available from the container at
`host.docker.internal:<port>`. The container's `localhost` refers to Debian.

## Application ownership

The default **VS Code (user-owned)** launcher uses `~/apps/vscode`. Its
application files are writable by the user.

**VS Code (system-owned)** uses root-owned `/opt/vscode-system` and a separate
profile. Extensions are shared through `--extensions-dir`. This window
reproduces the read-only application case.

## Stop, resume and diagnose

```powershell
docker stop ai-agent-bridge-debian-gui
docker start ai-agent-bridge-debian-gui
docker logs --tail 20 ai-agent-bridge-debian-gui
```

Desktop, VNC and VS Code logs are under `~/gui-logs`. Removing the container
preserves the named volume; removing that volume also removes saved profiles.
