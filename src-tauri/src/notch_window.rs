// 刘海屏 (MacBook Pro 2021+) 顶部覆盖层窗口。
//
// 创建一个无边框、透明、置顶到状态栏之上的窗口。
// 空闲时窗口会在原生层隐藏；运行时窗口尺寸跟随前端 UI 形态动态收缩/展开，
// 避免透明 WebView 命中区域挡住状态栏或其他 App。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
const DEFAULT_NOTCH_WIDTH: f64 = 220.0;
#[cfg(target_os = "macos")]
const MIN_NOTCH_WIDTH: f64 = 160.0;
#[cfg(target_os = "macos")]
const MAX_NOTCH_WIDTH: f64 = 320.0;
#[cfg(target_os = "macos")]
const ACTIVE_SIDE_WIDTH: f64 = 118.0;
#[cfg(target_os = "macos")]
const DEFAULT_OVERLAY_HEIGHT: f64 = 44.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchMetrics {
    /// 物理屏幕宽度 (pt)
    pub screen_width: f64,
    /// 物理屏幕高度 (pt)
    pub screen_height: f64,
    /// 顶部安全区高度 — 有刘海时通常 32~38pt
    pub safe_area_top: f64,
    /// 刘海左侧可用矩形宽度
    pub aux_left_width: f64,
    /// 刘海右侧可用矩形宽度
    pub aux_right_width: f64,
    /// 刘海中心宽度（推算值 = screen_width - aux_left - aux_right）
    pub notch_width: f64,
    /// 是否检测到刘海
    pub has_notch: bool,
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn get_notch_metrics() -> Result<NotchMetrics, String> {
    use objc2::MainThreadMarker;

    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "get_notch_metrics must run on the main thread".to_string())?;
    // 用 notch_screen 而非 mainScreen:mainScreen 跟键盘焦点走,主窗口在副屏 /
    // Spaces 切换瞬间会指向错误的屏,导致 metrics(刘海宽度、safe area)失真。
    let screen = notch_screen(mtm).ok_or_else(|| "no available screen".to_string())?;

    let frame = screen.frame();
    let insets = screen.safeAreaInsets();
    let aux_left = screen.auxiliaryTopLeftArea().size.width;
    let aux_right = screen.auxiliaryTopRightArea().size.width;

    let notch_width = (frame.size.width - aux_left - aux_right).max(0.0);
    let has_notch = insets.top > 0.0;

    Ok(NotchMetrics {
        screen_width: frame.size.width,
        screen_height: frame.size.height,
        safe_area_top: insets.top,
        aux_left_width: aux_left,
        aux_right_width: aux_right,
        notch_width,
        has_notch,
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn get_notch_metrics() -> Result<NotchMetrics, String> {
    Ok(NotchMetrics {
        screen_width: 0.0,
        screen_height: 0.0,
        safe_area_top: 0.0,
        aux_left_width: 0.0,
        aux_right_width: 0.0,
        notch_width: 0.0,
        has_notch: false,
    })
}

const NOTCH_WINDOW_LABEL: &str = "notch-overlay";

#[cfg(target_os = "macos")]
fn on_main_thread_blocking<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(AppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    if objc2::MainThreadMarker::new().is_some() {
        log::debug!("[notch] already on main thread");
        return Ok(f(app.clone()));
    }

    log::debug!("[notch] scheduling task on main thread");
    let (tx, rx) = std::sync::mpsc::channel();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(app_for_main));
    })
    .map_err(|e| format!("failed to schedule notch task on main thread: {e}"))?;

    rx.recv()
        .map_err(|e| format!("failed to receive notch main-thread result: {e}"))
}

#[cfg(target_os = "macos")]
fn normalized_notch_width(metrics: &NotchMetrics) -> f64 {
    if !metrics.has_notch
        || metrics.notch_width < MIN_NOTCH_WIDTH
        || metrics.notch_width > MAX_NOTCH_WIDTH
    {
        DEFAULT_NOTCH_WIDTH
    } else {
        metrics.notch_width.clamp(MIN_NOTCH_WIDTH, MAX_NOTCH_WIDTH)
    }
}

#[cfg(target_os = "macos")]
fn default_collapsed_bounds(metrics: &NotchMetrics) -> (f64, f64, f64, f64) {
    let width = normalized_notch_width(metrics) + ACTIVE_SIDE_WIDTH * 2.0;
    let height = metrics.safe_area_top.max(DEFAULT_OVERLAY_HEIGHT);
    let x = ((metrics.screen_width - width) / 2.0).max(0.0);
    (width, height, x, 0.0)
}

fn position_overlay_top_center(window: &tauri::WebviewWindow, width: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // 走原生 NSScreen + NSWindow setFrame:display:animate: 路径,保证位置与尺寸
        // 永远在同一帧内 commit,避免 macOS 把 set_position / set_size 两个 IPC
        // 调用拆成不同 runloop 周期,产生肉眼可见的"先漂移再回正"中间态。
        // set_overlay_frame_atomic 要求 main thread;若不在 main thread,跳过原生
        // 路径走 Tauri 通用 set_position 兜底。
        if objc2::MainThreadMarker::new().is_some() {
            if let Ok(size) = window.outer_size() {
                let scale = window.scale_factor().unwrap_or(1.0);
                let height = size.height as f64 / scale;
                return set_overlay_frame_atomic(window, width, height);
            }
        }
    }
    let monitor = window
        .primary_monitor()
        .map_err(|e| format!("failed to get primary monitor: {e}"))?
        .or(window
            .current_monitor()
            .map_err(|e| format!("failed to get current monitor: {e}"))?);
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let screen_width = monitor.size().width as f64 / scale;
        let x = ((screen_width - width) / 2.0).max(0.0);
        window
            .set_position(tauri::LogicalPosition::new(x, 0.0))
            .map_err(|e| format!("failed to reposition notch window: {e}"))?;
    }
    Ok(())
}

fn set_overlay_bounds(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
    screen_width: f64,
    screen_height: f64,
) -> Result<(), String> {
    let width = width.clamp(1.0, screen_width.max(600.0));
    let height = height.clamp(1.0, screen_height.max(240.0));

    #[cfg(target_os = "macos")]
    {
        // macOS:setFrame:display:animate: 把 origin + size 一次性 commit,
        // 避免分开调用 set_position / set_size 在窗口动画切换瞬间出现
        // "位置已更新但尺寸还是旧值"(或反之)的肉眼可见跳动。
        if objc2::MainThreadMarker::new().is_some() {
            return set_overlay_frame_atomic(window, width, height);
        }
    }

    position_overlay_top_center(window, width)?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("failed to resize notch window: {e}"))
}

#[cfg(target_os = "macos")]
fn notch_screen(
    mtm: objc2::MainThreadMarker,
) -> Option<objc2::rc::Retained<objc2_app_kit::NSScreen>> {
    use objc2_app_kit::NSScreen;

    // 优先返回带物理刘海(safeAreaInsets.top > 0)的那块屏。
    //
    // 为什么不直接用 NSScreen.mainScreen():mainScreen 是"含键盘焦点窗口的屏",
    // 在 Spaces 切换 / 全屏切换瞬间会跟着活跃 Space 跳到副屏或全屏专属 Space,
    // 造成 frame.size.height 不一致 — y_bottom = origin.y + height - notch_h
    // 直接算出错的 origin,窗口就掉到菜单栏下方约一个菜单栏高度(用户看到的
    // "向下偏移几像素"就是这个),要等下一次 keep-alive ticker 重算才回正。
    //
    // 物理刘海所在的屏幕对应 NSScreen 是稳定的,不随焦点切换,因此用 safeAreaInsets
    // 做指针更可靠。
    let screens = NSScreen::screens(mtm);
    for screen in screens.iter() {
        if screen.safeAreaInsets().top > 0.0 {
            return Some(screen);
        }
    }
    // 非刘海机型:第一块屏通常带菜单栏,再不行 fallback 到 mainScreen。
    if let Some(first) = screens.iter().next() {
        return Some(first);
    }
    NSScreen::mainScreen(mtm)
}

/// 从 Tauri WebviewWindow 取原生 NSWindow 强引用。
#[cfg(target_os = "macos")]
fn overlay_ns_window(
    window: &tauri::WebviewWindow,
) -> Result<objc2::rc::Retained<objc2_app_kit::NSWindow>, String> {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSView, NSWindow};
    use raw_window_handle::HasWindowHandle;

    let handle = window.window_handle().map_err(|e| e.to_string())?;
    if let raw_window_handle::RawWindowHandle::AppKit(appkit) = handle.as_raw() {
        let ns_view = appkit.ns_view.as_ptr() as *const NSView;
        let ns_window: Retained<NSWindow> = unsafe { &*ns_view }
            .window()
            .ok_or_else(|| "no NSWindow from NSView".to_string())?;
        return Ok(ns_window);
    }
    Err("not an AppKit window".to_string())
}

#[cfg(target_os = "macos")]
fn set_overlay_frame_atomic(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "set_overlay_frame_atomic must run on main thread".to_string())?;
    let screen = notch_screen(mtm).ok_or_else(|| "no notch screen".to_string())?;
    let screen_frame = screen.frame();

    let x = screen_frame.origin.x + ((screen_frame.size.width - width) / 2.0).max(0.0);
    // NSWindow 用左下角原点;我们要让窗口顶边贴齐屏幕顶边
    //   → bottom_y = screen_top_y - height
    //              = (screen.origin.y + screen.size.height) - height
    let y_bottom = screen_frame.origin.y + screen_frame.size.height - height;

    let ns_window = overlay_ns_window(window)?;
    let frame = NSRect::new(NSPoint::new(x, y_bottom), NSSize::new(width, height));
    // animate=false:位置/尺寸瞬时同步 commit。前端 CSS 上的 spring morph
    // 由内部 div 的 width/height transition 负责,这里只保证窗口本身永远
    // 在屏幕中线上,没有"先去左上/右上再回正"的中间帧。
    ns_window.setFrame_display_animate(frame, true, false);
    Ok(())
}

/// 位置漂移 watchdog:窗口被移动后校验是否仍在"刘海屏顶部水平居中",
/// 偏离则立即原子拉回。
///
/// 漂移来源是 macOS 窗口管理在 Space 切换 / 全屏过渡 / App 激活等路径下
/// 对 CanJoinAllSpaces 置顶窗口的被动 reposition — 应用代码自己从不把窗口
/// 放到别处。此前唯一的纠正手段是前端 JS 定时器(1s keep-alive / 5s drift
/// resend),但主窗口失焦后 WKWebView 会对后台定时器节流,用户会看到错位
/// 持续 1~3 秒才回正。挂在 Rust 侧 Moved 事件上则不受 JS 节流影响,漂移
/// 发生的同一事件循环内就被拉回。
///
/// 不会与自身 setFrame 形成反馈环:拉回后位置即为期望值,后续 Moved 事件
/// 检查偏差 < 0.5pt 直接 return。
#[cfg(target_os = "macos")]
fn snap_overlay_back_if_drifted(window: &tauri::WebviewWindow) {
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSPoint, NSRect};

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(screen) = notch_screen(mtm) else {
        return;
    };
    let Ok(ns_window) = overlay_ns_window(window) else {
        return;
    };

    let screen_frame = screen.frame();
    let frame = ns_window.frame();
    let expected_x =
        screen_frame.origin.x + ((screen_frame.size.width - frame.size.width) / 2.0).max(0.0);
    let expected_y = screen_frame.origin.y + screen_frame.size.height - frame.size.height;

    let dx = (frame.origin.x - expected_x).abs();
    let dy = (frame.origin.y - expected_y).abs();
    if dx <= 0.5 && dy <= 0.5 {
        return;
    }

    log::info!(
        "[notch] drift detected dx={dx:.1} dy={dy:.1} (at {:.1},{:.1}), snapping back to ({expected_x:.1},{expected_y:.1})",
        frame.origin.x,
        frame.origin.y,
    );
    let fixed = NSRect::new(NSPoint::new(expected_x, expected_y), frame.size);
    ns_window.setFrame_display_animate(fixed, true, false);
}

/// 创建（或显示/隐藏）刘海覆盖层窗口。**必须在主线程上调用**
/// （NSScreen API 与 NSWindow 操作都要求 main thread）。
pub fn create_notch_overlay(app: &AppHandle, visible: bool) -> Result<(), String> {
    log::debug!("[notch] create_notch_overlay visible={visible}");

    if let Some(existing) = app.get_webview_window(NOTCH_WINDOW_LABEL) {
        log::debug!("[notch] overlay already exists, visible={visible}");
        if visible {
            let scale = existing.scale_factor().unwrap_or(1.0);
            if let Ok(size) = existing.outer_size() {
                let width = size.width as f64 / scale;
                let _ = position_overlay_top_center(&existing, width);
            }
            #[cfg(target_os = "macos")]
            {
                let _ = elevate_to_status_layer(&existing);
                // orderFrontRegardless:显示窗口并强行顶到当前 Space 最前,且不
                // makeKey、不要求 app active(他人全屏 Space 内 orderFront:nil
                // 偶尔会被全屏窗口管理器压住,regardless 不会)。
                //
                // 不要在这之后再叠 existing.show() — tao 的 set_visible(true)
                // 走 makeKeyAndOrderFront,而 keep-alive 每秒会重放本命令,等于
                // 每秒把键盘焦点从主窗口抢走一次(表现:主窗口按钮要连点多次
                // 才生效)。focusable(false) 之外的第二道保险。
                let _ = order_front_regardless(&existing);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = existing.show();
        } else {
            let _ = existing.hide();
        }
        return Ok(());
    }

    let metrics = get_notch_metrics()?;

    // 初始只创建折叠态窗口。后续由前端通过 set_notch_overlay_bounds
    // 按 active/hover/expanded 形态调整原生窗口大小。
    #[cfg(target_os = "macos")]
    let (width, height, x, y) = {
        log::debug!("[notch] metrics = {:?}", metrics);
        default_collapsed_bounds(&metrics)
    };
    #[cfg(not(target_os = "macos"))]
    let (width, height, x, y) = (600.0_f64, 240.0_f64, 0.0_f64, 0.0_f64);

    log::debug!("[notch] creating overlay window {width}x{height} at ({x}, {y})");

    let url = WebviewUrl::App("index.html?notch=1".into());

    let window = WebviewWindowBuilder::new(app, NOTCH_WINDOW_LABEL, url)
        .title(format!("{} Notch", crate::constants::APP_NAME))
        .inner_size(width, height)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        // focusable(false) → tao 把 canBecomeKeyWindow 钉死为 false:覆盖层永远
        // 不能成为 key window,无论是 show() 还是用户点击都抢不走主窗口的键盘
        // 焦点。鼠标事件分发不要求 key window,展开面板内全部是点击交互(无文本
        // 输入),所以审批按钮等照常可点。
        .focusable(false)
        .shadow(false)
        .build()
        .map_err(|e| format!("failed to build notch window: {e}"))?;

    // macOS：把窗口提升到状态栏之上，并允许在所有 Space / 全屏副屏显示。
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = elevate_to_status_layer(&window) {
            log::warn!("[notch] elevate_to_status_layer failed: {}", e);
        }
        // 位置漂移 watchdog:系统(Space 切换/全屏过渡/窗口激活)把 overlay
        // 挪走时,Moved 事件在主线程同步触发,立即拉回刘海位,不再依赖前端
        // JS 定时器兜底(失焦后会被 WKWebView 节流,错位会持续 1~3 秒)。
        let watchdog = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Moved(_)) {
                snap_overlay_back_if_drifted(&watchdog);
            }
        });
        // 首次创建时,默认让窗口穿透鼠标事件 — 等前端 mount 后通过 invoke
        // 同步当前 mode 对应的值。否则在 React 组件挂载完成前的几十毫秒里,
        // overlay 会按 NSWindow 默认值(ignores=false)拦截 menu bar 区域的点击。
        if let Err(e) = set_window_ignores_mouse_events(&window, true) {
            log::warn!("[notch] initial setIgnoresMouseEvents failed: {}", e);
        }
    }

    if visible {
        let _ = set_overlay_bounds(
            &window,
            width,
            height,
            metrics.screen_width,
            metrics.screen_height,
        );
        // 同上:macOS 用 orderFrontRegardless 显示,避免 show() 的 makeKey 抢焦点。
        #[cfg(target_os = "macos")]
        let _ = order_front_regardless(&window);
        #[cfg(not(target_os = "macos"))]
        let _ = window.show();
    } else {
        let _ = window.hide();
    }
    log::debug!("[notch] overlay window built, visible={visible}");

    Ok(())
}

/// 前端可调用的 Tauri 命令版本。
#[tauri::command]
pub fn show_notch_overlay(app: AppHandle) -> Result<(), String> {
    log::debug!("[notch] command show_notch_overlay");
    #[cfg(target_os = "macos")]
    {
        on_main_thread_blocking(&app, |app| create_notch_overlay(&app, true))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        create_notch_overlay(&app, true)
    }
}

/// 按当前 UI 形态缩放原生覆盖层窗口，避免透明区域挡住菜单栏/其他 App。
#[tauri::command]
pub fn set_notch_overlay_bounds(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    log::debug!("[notch] command set_notch_overlay_bounds {width}x{height}");
    #[cfg(target_os = "macos")]
    {
        on_main_thread_blocking(&app, move |app| {
            let metrics = get_notch_metrics()?;
            if let Some(existing) = app.get_webview_window(NOTCH_WINDOW_LABEL) {
                set_overlay_bounds(
                    &existing,
                    width,
                    height,
                    metrics.screen_width,
                    metrics.screen_height,
                )?;
            }
            Ok(())
        })?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let metrics = get_notch_metrics()?;
        if let Some(existing) = app.get_webview_window(NOTCH_WINDOW_LABEL) {
            set_overlay_bounds(
                &existing,
                width,
                height,
                metrics.screen_width,
                metrics.screen_height,
            )?;
        }
        Ok(())
    }
}

/// 隐藏刘海覆盖层窗口，释放状态栏/其他 App 在该区域的鼠标命中。
#[tauri::command]
pub fn hide_notch_overlay(app: AppHandle) -> Result<(), String> {
    log::debug!("[notch] command hide_notch_overlay");
    #[cfg(target_os = "macos")]
    {
        on_main_thread_blocking(&app, |app| {
            if let Some(existing) = app.get_webview_window(NOTCH_WINDOW_LABEL) {
                existing
                    .hide()
                    .map_err(|e| format!("failed to hide notch window: {e}"))?;
            }
            Ok(())
        })?
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(existing) = app.get_webview_window(NOTCH_WINDOW_LABEL) {
            existing
                .hide()
                .map_err(|e| format!("failed to hide notch window: {e}"))?;
        }
        Ok(())
    }
}

/// 从刘海窗口请求主窗口中止当前活跃流。
#[tauri::command]
pub fn abort_active_stream(app: AppHandle) -> Result<(), String> {
    app.emit_to("main", "notch:abort-active-stream", ())
        .map_err(|e| format!("failed to emit notch abort event: {e}"))
}

/// 从刘海窗口聚焦主窗口。
#[tauri::command]
pub fn focus_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        window
            .set_focus()
            .map_err(|e| format!("failed to focus main window: {e}"))?;
    }
    Ok(())
}

/// 切换 overlay 是否忽略鼠标事件 — 关键的"点击穿透"开关。
///
/// 灵动岛的物理刘海覆盖区是 menu bar / 全屏 App 顶部 UI 共用空间。如果 NSWindow
/// 默认捕获所有鼠标事件,用户在 Bytro 全屏时点击顶部 toolbar 的按钮会被悄悄
/// 吃掉。设 `ignore=true` 让 NSWindow 把所有 mouse hit 透传给下方应用,设
/// `ignore=false` 让它正常接收(展开态需要响应外部点击关闭、按钮点击等)。
///
/// 调用方:前端 NotchOverlay 在 mode 切换时通过 invoke 触发(见 notch-overlay.tsx)。
#[tauri::command]
pub fn set_notch_overlay_ignore_mouse(app: AppHandle, ignore: bool) -> Result<(), String> {
    log::debug!("[notch] command set_notch_overlay_ignore_mouse ignore={ignore}");
    #[cfg(target_os = "macos")]
    {
        on_main_thread_blocking(&app, move |app| {
            if let Some(existing) = app.get_webview_window(NOTCH_WINDOW_LABEL) {
                set_window_ignores_mouse_events(&existing, ignore)?;
            }
            Ok(())
        })?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, ignore);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
thread_local! {
    /// 展开态"点外收起"的全局鼠标 monitor 句柄。AnyObject 非 Send,
    /// 所有存取都经 on_main_thread_blocking 收敛到主线程。
    static COLLAPSE_MONITOR: std::cell::RefCell<Option<objc2::rc::Retained<objc2::runtime::AnyObject>>> =
        const { std::cell::RefCell::new(None) };
}

/// 展开态期间监听本 App 之外的全局鼠标按下,触发即通知覆盖层收起。
///
/// 覆盖层窗口是 focusable(false) 永不获焦,无法依赖失焦事件做"点外收起";
/// NSEvent global monitor 是 AppKit 弹层的标准替代(NSMenu 同款机制),且鼠标类
/// monitor 不需要辅助功能权限(键盘类才需要)。global monitor 只收到**其他 App**
/// 的事件 — 点击覆盖层或主窗口不会到这里,所以一触发必然是"点了外面",无需再
/// 判断坐标;本 App 内的点击由主窗口 pointerdown 广播收起(见 use-notch-broadcaster)。
///
/// 调用方:前端 NotchOverlay 在 mode 进入/离开 expanded 时 invoke(见 notch-overlay.tsx)。
#[tauri::command]
pub fn set_notch_collapse_watch(app: AppHandle, enabled: bool) -> Result<(), String> {
    log::debug!("[notch] command set_notch_collapse_watch enabled={enabled}");
    #[cfg(target_os = "macos")]
    {
        on_main_thread_blocking(&app, move |app| {
            if enabled {
                install_collapse_monitor(&app);
            } else {
                remove_collapse_monitor();
            }
            Ok(())
        })?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn install_collapse_monitor(app: &AppHandle) {
    use objc2_app_kit::{NSEvent, NSEventMask};

    if COLLAPSE_MONITOR.with(|slot| slot.borrow().is_some()) {
        return;
    }

    let app = app.clone();
    let block = block2::RcBlock::new(move |_event: std::ptr::NonNull<NSEvent>| {
        // 事件名与前端 notch-bridge.ts 的 NOTCH_COLLAPSE_EVENT 保持一致。
        let _ = app.emit_to(NOTCH_WINDOW_LABEL, "notch:collapse", ());
    });
    let monitor = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown,
        &block,
    );
    if monitor.is_none() {
        log::warn!("[notch] addGlobalMonitorForEventsMatchingMask returned nil");
    }
    COLLAPSE_MONITOR.with(|slot| *slot.borrow_mut() = monitor);
}

#[cfg(target_os = "macos")]
fn remove_collapse_monitor() {
    COLLAPSE_MONITOR.with(|slot| {
        if let Some(monitor) = slot.borrow_mut().take() {
            unsafe { objc2_app_kit::NSEvent::removeMonitor(&monitor) };
        }
    });
}

#[cfg(target_os = "macos")]
fn order_front_regardless(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ns_window = overlay_ns_window(window)?;
    ns_window.orderFrontRegardless();
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_window_ignores_mouse_events(
    window: &tauri::WebviewWindow,
    ignore: bool,
) -> Result<(), String> {
    let ns_window = overlay_ns_window(window)?;
    ns_window.setIgnoresMouseEvents(ignore);
    Ok(())
}

#[cfg(target_os = "macos")]
fn elevate_to_status_layer(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::NSWindowCollectionBehavior;

    let ns_window = overlay_ns_window(window)?;
    {
        // 强化 transparent 双保险:Tauri 的 .transparent(true) 已经设了一遍,但
        // 在 Spaces 切换/全屏 App 切换的图形管线异常路径下可能短暂失效。这里
        // 直接通过 NSWindow API 再设一遍,确保 backgroundColor 一定是 clearColor、
        // window 一定是 non-opaque、不画 shadow,避免任何"露出底色"的瞬间。
        ns_window.setOpaque(false);
        let clear = objc2_app_kit::NSColor::clearColor();
        ns_window.setBackgroundColor(Some(&clear));
        ns_window.setHasShadow(false);

        // macOS window level 选型说明:
        //   25   = NSStatusBar           ← 会被 Spaces 切换图层盖住(实测黑块跟着窗口滑)
        //   1000 = NSScreenSaver         ← 仍会被全屏 App 切换时的"刘海避让黑边图层"盖住
        //   1500 = AssistiveTechHigh     ← 辅助技术级,实测能盖过 Spaces 切换时所有系统图层
        //   2147483630 = CGCursorWindow  ← 跟光标同 level,不推荐(cursor 渲染会异常)
        //
        // 选 1500: 高于全屏切换时的 system overlay,但低于光标/系统密码框,行为最干净。
        ns_window.setLevel(1500);

        // CollectionBehavior 标志解释:
        //   CanJoinAllSpaces       — 出现在所有 Space(含其他 App 全屏 Space 与桌面 Space)
        //   FullScreenAuxiliary    — 允许在他人全屏 App 上方显示(关键)
        //   Stationary             — Exposé / Mission Control 时不被聚拢
        //   IgnoresCycle           — 不参与 Cmd-` 窗口循环
        //   Transient              — 不出现在 Mission Control / 任务管理器
        //
        // 不带 Stationary:实测它会和 CanJoinAllSpaces 在某些路径下冲突,导致 Spaces
        // 切换瞬间窗口短暂从渲染队列里掉出来,用户看到刘海"消失一下又回来"。
        let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::Transient;
        ns_window.setCollectionBehavior(behavior);

        // 覆盖层不参与 Cmd-Tab,也不在 Dock 里。
        ns_window.setHidesOnDeactivate(false);

        // 注意:不在这里设 setIgnoresMouseEvents — elevate_to_status_layer 会
        // 在每次 show_notch_overlay 时被重新调用,此处若强制写死会覆盖前端
        // 通过 set_notch_overlay_ignore_mouse 同步过来的值,造成展开态被悄悄
        // 切回穿透。开关由前端 NotchOverlay 的 mode useEffect 主导。
    }

    Ok(())
}
