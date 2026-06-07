import os
import asyncio
import sys
from pathlib import Path
import subprocess

class OpenVPNRunner:
    def __init__(self, netns_mgr, data_dir="/opt/vpngate-pro/vpngate_data"):
        self.netns_mgr = netns_mgr
        self.data_dir = Path(data_dir)
        self.config_file = self.data_dir / "current.ovpn"
        self.proc = None
        self.connected = False
        self.conn_message = "未连接"
        self.current_node_id = ""

    def ensure_dirs(self):
        self.data_dir.mkdir(parents=True, exist_ok=True)

    async def start(self, node_id, config_text):
        """Start OpenVPN inside the network namespace."""
        self.ensure_dirs()
        await self.stop()
        
        self.current_node_id = node_id
        self.connected = False
        self.conn_message = "正在连接..."
        
        # Check and download Let's Encrypt Generation Y roots if they aren't present
        gen_y_root_path = self.data_dir / "root-yr.pem"
        gen_y_int_path = self.data_dir / "int-yr1.pem"
        
        if not gen_y_root_path.exists() or not gen_y_int_path.exists():
            import urllib.request
            try:
                print("[OpenVPN] Downloading Let's Encrypt Generation Y roots...", flush=True)
                if not gen_y_root_path.exists():
                    url = "https://letsencrypt.org/certs/gen-y/root-yr.pem"
                    urllib.request.urlretrieve(url, gen_y_root_path)
                if not gen_y_int_path.exists():
                    url = "https://letsencrypt.org/certs/gen-y/int-yr1.pem"
                    urllib.request.urlretrieve(url, gen_y_int_path)
            except Exception as e:
                print(f"[OpenVPN] Failed to download Gen-Y CAs: {e}", flush=True)

        # On Linux, merge system CA bundle to trust public CAs (like Let's Encrypt)
        ca_text = ""
        ca_bundle_path = Path("/etc/ssl/certs/ca-certificates.crt")
        if ca_bundle_path.exists():
            try:
                ca_text += ca_bundle_path.read_text(encoding="utf-8")
            except Exception as e:
                print(f"[OpenVPN] Failed to read system CAs: {e}", flush=True)

        # Append Generation Y CAs if successfully downloaded
        for p in [gen_y_root_path, gen_y_int_path]:
            if p.exists():
                try:
                    ca_text += "\n" + p.read_text(encoding="utf-8")
                except Exception:
                    pass

        if ca_text and "</ca>" in config_text:
            config_text = config_text.replace("</ca>", f"\n{ca_text}\n</ca>")

        # Write temporary ovpn config
        try:
            self.config_file.write_text(config_text, encoding="utf-8")
        except Exception as e:
            self.conn_message = f"配置写入失败: {e}"
            return False

        # Build command: [ip, netns, exec, vpn_ns] + [openvpn, --config, file]
        prefix = self.netns_mgr.get_ns_prefix()
        cmd = prefix + [
            "openvpn",
            "--config", str(self.config_file),
            "--dev", "tun0",
            "--data-ciphers", "AES-128-CBC:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305",
            "--script-security", "2",
            "--tls-verify", "/bin/true",
        ]
        
        print(f"[OpenVPN] Launching OpenVPN for node {node_id}: {' '.join(cmd)}", flush=True)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT
            )
            # Start background stdout listener
            asyncio.create_task(self._read_logs())
            
            # Wait up to 30 seconds for connection success
            for _ in range(30):
                if self.connected:
                    return True
                if self.proc is None or self.proc.returncode is not None:
                    self.conn_message = "OpenVPN 进程异常退出"
                    return False
                await asyncio.sleep(1)
            
            self.conn_message = "连接超时 (30秒)"
            return False
        except Exception as e:
            self.conn_message = f"启动失败: {e}"
            print(f"[OpenVPN] Failed to start process: {e}", flush=True)
            return False

    async def _read_logs(self):
        """Asynchronously read and log OpenVPN stdout."""
        if not self.proc or not self.proc.stdout:
            return
            
        try:
            while True:
                line_bytes = await self.proc.stdout.readline()
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                
                # Print to stdout/service logs
                print(f"[OpenVPN Log] {line}", flush=True)
                
                # Check for completion signal
                if "Initialization Sequence Completed" in line:
                    self.connected = True
                    self.conn_message = "连接成功"
                elif "AUTH_FAILED" in line:
                    self.conn_message = "认证失败"
                elif "TLS Error" in line or "TLS_ERROR" in line:
                    self.conn_message = "TLS 握手失败"
                elif "SIGTERM" in line or "SIGINT" in line or "exiting" in line:
                    self.connected = False
                    self.conn_message = "已断开连接"
        except Exception as e:
            print(f"[OpenVPN] Error reading logs: {e}", flush=True)
        finally:
            self.connected = False
            if self.conn_message == "连接成功" or self.conn_message == "正在连接...":
                self.conn_message = "连接已终止"

    async def stop(self):
        """Terminate the OpenVPN process cleanly."""
        self.connected = False
        self.current_node_id = ""
        
        if self.proc:
            print("[OpenVPN] Terminating OpenVPN process...", flush=True)
            try:
                self.proc.terminate()
                # Wait up to 3 seconds for graceful exit
                try:
                    await asyncio.wait_for(self.proc.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    print("[OpenVPN] Force killing OpenVPN process...", flush=True)
                    self.proc.kill()
                    await self.proc.wait()
            except Exception as e:
                print(f"[OpenVPN] Error stopping process: {e}", flush=True)
            finally:
                self.proc = None
                
        # Clean up temp file
        if self.config_file.exists():
            try:
                self.config_file.unlink()
            except Exception:
                pass
        
        # Double check pkill in namespace to ensure no orphaned processes
        if self.netns_mgr.is_linux:
            prefix = self.netns_mgr.get_ns_prefix()
            subprocess_cmd = prefix + ["pkill", "-f", "openvpn"]
            try:
                subprocess.run(subprocess_cmd, capture_output=True)
            except Exception:
                pass

        self.conn_message = "已断开连接"

    def is_running(self):
        """Check if OpenVPN is currently running."""
        return self.proc is not None and self.proc.returncode is None
