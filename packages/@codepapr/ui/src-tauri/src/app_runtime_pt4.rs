    fn csp_allows_own_backend_port_when_network_off() {
        use crate::papr_runtime::permission::{PaprAccess, PaprLocalAccess};
        let access = PaprAccess { local: PaprLocalAccess::Read, network: false };
        let csp = build_app_csp(access, Some(3456));
        assert!(csp.contains("http://localhost:3456"), "got: {csp}");
        assert!(csp.contains("http://127.0.0.1:3456"), "got: {csp}");
        assert!(csp.contains("frame-src 'self' blob: http://localhost:3456"), "got: {csp}");
        assert!(!csp.contains("wss:"), "got: {csp}");
    }

    #[test]
    fn csp_opens_public_network_when_network_on() {
        use crate::papr_runtime::permission::{PaprAccess, PaprLocalAccess};
        let access = PaprAccess { local: PaprLocalAccess::Read, network: true };
        let csp = build_app_csp(access, None);
        assert!(csp.contains("connect-src 'self' https: http: wss: ws:"), "got: {csp}");
        assert!(csp.contains("form-action 'none' https:"), "got: {csp}");
        assert!(csp.contains("img-src 'self' data: blob: https:"), "got: {csp}");
        assert!(csp.contains("frame-src 'self' blob:"), "got: {csp}");
        assert!(csp.contains("script-src 'self' https:"), "got: {csp}");
    }

    #[test]
    fn frontend_mtime_includes_nested_css_and_js() {
        let tmp = std::env::temp_dir().join(format!("papr-mtime-{}", std::process::id()));
        let app = tmp.join(".CodePapr/apps/ticker");
        fs::create_dir_all(app.join("js")).unwrap();
        fs::create_dir_all(app.join("css")).unwrap();
        fs::create_dir_all(app.join("node_modules/pkg")).unwrap();
        fs::write(app.join("css/theme.css"), "body{}").unwrap();
        fs::write(app.join("js/main.js"), "console.log(1)").unwrap();
        fs::write(app.join("node_modules/pkg/index.js"), "ignored").unwrap();
        let mtime = app_frontend_mtime(tmp.to_string_lossy().into(), "ticker".into()).unwrap();
        assert!(mtime > 0, "nested css/js must contribute to frontend mtime");

        let empty = tmp.join(".CodePapr/apps/empty-plugin");
        fs::create_dir_all(empty.join("node_modules/pkg")).unwrap();
        fs::write(empty.join("node_modules/pkg/index.js"), "ignored").unwrap();
        let skipped = app_frontend_mtime(tmp.to_string_lossy().into(), "empty-plugin".into()).unwrap();
        assert_eq!(skipped, 0, "node_modules must not trigger frontend reload");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn skip_export_entries_exclude_runtime_payload() {
        assert!(skip_app_export_entry("node_modules"));
        assert!(skip_app_export_entry(".versions"));
        assert!(skip_app_export_entry("data"));
        assert!(skip_app_export_entry("db.sqlite"));
        assert!(skip_app_export_entry("db.sqlite-wal"));
        assert!(!skip_app_export_entry("index.html"));
        assert!(!skip_app_export_entry("server.js"));
        assert!(!skip_app_export_entry("package.json"));
    }

    #[test]
    fn netstat_listen_pid_parsing() {
        let win = "  TCP    127.0.0.1:3456         0.0.0.0:0              LISTENING       4242\r\n\
              TCP    0.0.0.0:13456          0.0.0.0:0              LISTENING       99\r\n";
        assert_eq!(parse_netstat_listen_pids(win, 3456), vec![4242]);
        let linux = "tcp  0  0 127.0.0.1:8080  0.0.0.0:*  LISTEN  1001/node\n";
        assert_eq!(parse_netstat_listen_pids(linux, 8080), vec![1001]);
    }

    #[test]
    fn allocate_prefers_free_declared_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = listener.local_addr().unwrap().port();
        let allocated = allocate_app_port(busy).expect("should find a free port");
        assert_ne!(allocated, busy);
        drop(listener);
        let same = allocate_app_port(busy).expect("freed port should be reusable");
        assert_eq!(same, busy);
    }

    #[test]
    fn snapshot_and_export_skip_sqlite_and_node_modules() {
        let tmp = std::env::temp_dir().join(format!("papr-snap-{}", std::process::id()));
        let app = tmp.join(".CodePapr/apps/snap-app");
        fs::create_dir_all(app.join("node_modules/pkg")).unwrap();
        fs::write(app.join("index.html"), "<html>v1</html>").unwrap();
        fs::write(app.join("manifest.json"), "{\"name\":\"snap\"}").unwrap();
        fs::write(app.join("db.sqlite"), "secret").unwrap();
        fs::write(app.join("node_modules/pkg/index.js"), "x").unwrap();

        let snap = papr_snapshot_app(tmp.to_string_lossy().into(), "snap-app".into())
            .unwrap()
            .expect("snapshot path");
        let snap_path = std::path::PathBuf::from(&snap);
        assert!(snap_path.join("index.html").is_file());
        assert!(!snap_path.join("db.sqlite").exists());
        assert!(!snap_path.join("node_modules").exists());

        let zip_path = tmp.join("snap-app.zip");
        papr_export_app(
            tmp.to_string_lossy().into(),
            "snap-app".into(),
            zip_path.to_string_lossy().into(),
        )
        .unwrap();
        assert!(zip_path.is_file());
        let bytes = fs::read(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "index.html" || n.ends_with("/index.html")));
        assert!(names.iter().all(|n| !n.contains("db.sqlite") && !n.contains("node_modules")));

        fs::remove_dir_all(&tmp).ok();
    }
}
