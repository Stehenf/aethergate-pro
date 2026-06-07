import os
import json
import time
import uuid
import mimetypes
import asyncio
from pathlib import Path

class AsyncWebServer:
    def __init__(self, manager, host="0.0.0.0", port=8787):
        self.manager = manager
        self.host = host
        self.port = port
        self.server = None
        self.sessions = {} # token -> expiry_timestamp
        
        self.web_dir = Path("/Users/jfg/Desktop/vpngate-pro/web")
        if not self.web_dir.exists():
            self.web_dir = Path(__file__).parent.parent / "web"

    async def start(self):
        self.server = await asyncio.start_server(
            self.handle_client, self.host, self.port
        )
        print(f"[Web] Web Dashboard Server listening on http://{self.host}:{self.port}/", flush=True)

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None

    async def handle_client(self, reader, writer):
        try:
            # Read HTTP request header
            header_data = b""
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                header_data += chunk
                if b"\r\n\r\n" in header_data:
                    break

            if not header_data:
                writer.close()
                return

            header_part, body_part = header_data.split(b"\r\n\r\n", 1)
            lines = header_part.decode("utf-8", errors="replace").split("\r\n")
            request_line = lines[0].split()
            if len(request_line) < 3:
                writer.close()
                return

            method, path, _ = request_line
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()

            # Read remaining body if Content-Length specified
            content_length = int(headers.get("content-length", 0))
            body = body_part
            if len(body) < content_length:
                body += await reader.readexactly(content_length - len(body))

            # Parse cookies
            cookie_header = headers.get("cookie", "")
            cookies = {}
            if cookie_header:
                for item in cookie_header.split(";"):
                    if "=" in item:
                        k, v = item.split("=", 1)
                        cookies[k.strip()] = v.strip()

            # Handle routing
            await self.route_request(writer, method, path, headers, cookies, body)
        except Exception as e:
            print(f"[Web] Error handling request: {e}", flush=True)
            try:
                writer.close()
            except Exception:
                pass

    async def route_request(self, writer, method, path, headers, cookies, body):
        # 1. Clean Path
        clean_path = path.split("?")[0]
        secret_path = self.manager.config.get("secret_path", "")
        prefix = f"/{secret_path}" if secret_path else ""

        # Redirect root paths to secret path or handle index
        if clean_path in ("/", "/index.html"):
            if prefix:
                self.send_redirect(writer, f"{prefix}/")
                return
            else:
                await self.serve_dashboard_or_login(writer, cookies)
                return
        
        # Match prefixed dashboard paths
        if prefix and clean_path == f"{prefix}/":
            await self.serve_dashboard_or_login(writer, cookies)
            return

        if prefix and clean_path.startswith(f"{prefix}/web/"):
            # Strip prefix and serve static web assets
            relative_path = clean_path.replace(f"{prefix}/web/", "")
            await self.serve_static_file(writer, relative_path)
            return

        # Check APIs
        api_path = clean_path
        if prefix:
            if clean_path.startswith(f"{prefix}/api/"):
                api_path = clean_path.replace(prefix, "")
            else:
                self.send_json(writer, {"error": "Unauthorized"}, 401)
                return

        # API Handlers
        if api_path == "/api/login" and method == "POST":
            await self.handle_login(writer, body)
        elif api_path == "/api/nodes" and method == "GET":
            if not self.is_authorized(cookies):
                self.send_json(writer, {"error": "Unauthorized"}, 401)
            else:
                await self.handle_get_nodes(writer)
        elif api_path == "/api/connect" and method == "POST":
            if not self.is_authorized(cookies):
                self.send_json(writer, {"error": "Unauthorized"}, 401)
            else:
                await self.handle_connect(writer, body)
        elif api_path == "/api/disconnect" and method == "POST":
            if not self.is_authorized(cookies):
                self.send_json(writer, {"error": "Unauthorized"}, 401)
            else:
                await self.handle_disconnect(writer)
        elif api_path == "/api/settings" and method == "POST":
            if not self.is_authorized(cookies):
                self.send_json(writer, {"error": "Unauthorized"}, 401)
            else:
                await self.handle_save_settings(writer, body)
        elif api_path == "/api/test_node" and method == "POST":
            if not self.is_authorized(cookies):
                self.send_json(writer, {"error": "Unauthorized"}, 401)
            else:
                await self.handle_test_node(writer, body)
        else:
            self.send_json(writer, {"error": "Not Found"}, 404)

    def is_authorized(self, cookies):
        # If no password set, bypass authentication
        pwd = self.manager.config.get("password")
        if not pwd:
            return True
            
        token = cookies.get("session")
        if not token or token not in self.sessions:
            return False
        
        # Check expiry
        if self.sessions[token] < time.time():
            del self.sessions[token]
            return False
            
        return True

    async def serve_dashboard_or_login(self, writer, cookies):
        if self.is_authorized(cookies):
            await self.serve_static_file(writer, "index.html")
        else:
            await self.serve_static_file(writer, "login.html")

    async def serve_static_file(self, writer, filename):
        file_path = self.web_dir / filename
        # Security check to prevent directory traversal
        try:
            resolved_path = file_path.resolve()
            if not str(resolved_path).startswith(str(self.web_dir.resolve())):
                self.send_json(writer, {"error": "Forbidden"}, 403)
                return
        except Exception:
            self.send_json(writer, {"error": "Not Found"}, 404)
            return

        if not resolved_path.exists() or resolved_path.is_dir():
            self.send_json(writer, {"error": "Not Found"}, 404)
            return

        # Determine MIME type
        mime_type, _ = mimetypes.guess_type(str(resolved_path))
        if not mime_type:
            mime_type = "application/octet-stream"

        try:
            content = await asyncio.to_thread(resolved_path.read_bytes)
            self.send_bytes(writer, content, mime_type)
        except Exception as e:
            self.send_json(writer, {"error": f"Internal Server Error: {e}"}, 500)

    async def handle_login(self, writer, body):
        try:
            payload = json.loads(body.decode("utf-8"))
            username = payload.get("username")
            password = payload.get("password")
            
            cfg_user = self.manager.config.get("username", "admin")
            cfg_pass = self.manager.config.get("password", "")
            
            if username == cfg_user and password == cfg_pass:
                # Generate session token
                token = str(uuid.uuid4())
                self.sessions[token] = time.time() + 24 * 3600 # 24 hours expiry
                
                cookie_header = f"session={token}; Path=/; HttpOnly; SameSite=Lax"
                self.send_json(writer, {"success": True}, headers={"Set-Cookie": cookie_header})
            else:
                self.send_json(writer, {"success": False, "error": "用户名或密码错误"}, 400)
        except Exception as e:
            self.send_json(writer, {"error": str(e)}, 400)

    async def handle_get_nodes(self, writer):
        nodes = await self.manager.get_filtered_nodes()
        state = self.manager.get_state_data()
        self.send_json(writer, {"nodes": nodes, "state": state})

    async def handle_connect(self, writer, body):
        try:
            payload = json.loads(body.decode("utf-8"))
            node_id = payload.get("node_id")
            if not node_id:
                self.send_json(writer, {"error": "Missing node_id"}, 400)
                return
            
            # Trigger connection task in background
            asyncio.create_task(self.manager.connect_node(node_id))
            self.send_json(writer, {"success": True, "message": "正在发起连接"})
        except Exception as e:
            self.send_json(writer, {"error": str(e)}, 400)

    async def handle_disconnect(self, writer):
        asyncio.create_task(self.manager.disconnect_node())
        self.send_json(writer, {"success": True, "message": "正在断开连接"})

    async def handle_save_settings(self, writer, body):
        try:
            payload = json.loads(body.decode("utf-8"))
            
            # Check if username or password is being changed
            credentials_changed = False
            new_username = payload.get("username")
            new_password = payload.get("password")
            
            if new_username is not None or new_password is not None:
                # Validate
                if new_username is not None and not new_username.strip():
                    self.send_json(writer, {"error": "用户名不能为空"}, 400)
                    return
                if new_password is not None and not new_password.strip():
                    self.send_json(writer, {"error": "密码不能为空"}, 400)
                    return
                credentials_changed = True
            
            await self.manager.update_settings(payload)
            
            if credentials_changed:
                # Clear all active sessions to force re-login
                self.sessions.clear()
                # Clear cookie by setting expired session cookie
                cookie_header = "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
                self.send_json(
                    writer, 
                    {"success": True, "message": "凭证已更新，请重新登录", "require_relogin": True}, 
                    headers={"Set-Cookie": cookie_header}
                )
            else:
                self.send_json(writer, {"success": True, "message": "设置已保存"})
        except Exception as e:
            self.send_json(writer, {"error": str(e)}, 400)

    async def handle_test_node(self, writer, body):
        try:
            payload = json.loads(body.decode("utf-8"))
            node_id = payload.get("node_id")
            if not node_id:
                self.send_json(writer, {"error": "Missing node_id"}, 400)
                return
                
            asyncio.create_task(self.manager.test_node_latency(node_id))
            self.send_json(writer, {"success": True, "message": "已开始检测节点延迟"})
        except Exception as e:
            self.send_json(writer, {"error": str(e)}, 400)

    def send_bytes(self, writer, body, content_type, status=200, headers=None):
        res = f"HTTP/1.1 {status} OK\r\n"
        res += f"Content-Type: {content_type}\r\n"
        res += f"Content-Length: {len(body)}\r\n"
        res += "Cache-Control: no-store, no-cache, must-revalidate\r\n"
        if headers:
            for k, v in headers.items():
                res += f"{k}: {v}\r\n"
        res += "\r\n"
        
        try:
            writer.write(res.encode("utf-8") + body)
            asyncio.create_task(self.safe_drain_close(writer))
        except Exception:
            pass

    async def safe_drain_close(self, writer):
        try:
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

    def send_json(self, writer, data, status=200, headers=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_bytes(writer, body, "application/json; charset=utf-8", status, headers)

    def send_redirect(self, writer, location):
        res = f"HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
        try:
            writer.write(res.encode("utf-8"))
            asyncio.create_task(self.safe_drain_close(writer))
        except Exception:
            pass
