using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class JKLauncher
{
    private const string SingleInstanceMutexName = @"Local\JK.ChatGPTToCodexLauncher";
    private const string ActivationEventName = @"Local\JK.ChatGPTToCodexLauncher.Activate";

    [STAThread]
    private static void Main(string[] args)
    {
        bool createdNew;
        // --ui-preview renders the window for design QA with an isolated
        // single-instance name so it never talks to (or replaces) a live JK.
        var preview = Array.Exists(args, value => string.Equals(value, "--ui-preview", StringComparison.OrdinalIgnoreCase));
        var previewSuffix = preview ? ".UiPreview" : string.Empty;
        // Keep the established mutex so existing and renamed launchers share one instance.
        using (var activationEvent = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, ActivationEventName + previewSuffix))
        using (var singleInstance = new System.Threading.Mutex(true, SingleInstanceMutexName + previewSuffix, out createdNew))
        {
            if (!createdNew)
            {
                try { activationEvent.Set(); } catch { }
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var form = new LauncherForm(args);
            var formHandle = form.Handle;
            var activationRegistration = System.Threading.ThreadPool.RegisterWaitForSingleObject(
                activationEvent,
                delegate
                {
                    if (form.IsDisposed) return;
                    try { form.BeginInvoke(new Action(form.ShowFromTray)); }
                    catch (InvalidOperationException) { }
                },
                null,
                System.Threading.Timeout.Infinite,
                false);
            try
            {
                Application.Run(form);
            }
            finally
            {
                activationRegistration.Unregister(null);
            }
        }
    }
}

internal sealed class LauncherForm : Form
{
    private static string GetEnvironmentValue(string jkName, string legacyName)
    {
        var value = Environment.GetEnvironmentVariable(jkName);
        return string.IsNullOrWhiteSpace(value) ? Environment.GetEnvironmentVariable(legacyName) : value;
    }

    private sealed class JkProject
    {
        public string projectId { get; set; }
        public string name { get; set; }
        public string root { get; set; }
        public string branch { get; set; }
        public bool dirty { get; set; }

        public override string ToString() { return string.IsNullOrWhiteSpace(name) ? projectId : name; }
    }

    private sealed class JkRole
    {
        public string id { get; set; }
        public string name { get; set; }
        public string description { get; set; }
        public string instructions { get; set; }
        public string permissionPreset { get; set; }
        public string[] tools { get; set; }
        public string[] skills { get; set; }
        public string workflowPreference { get; set; }
        public bool builtIn { get; set; }

        public override string ToString() { return name ?? id; }
    }

    private sealed class JkRoleContext
    {
        public string projectId { get; set; }
        public string projectName { get; set; }
        public JkRole role { get; set; }
        public string defaultRoleId { get; set; }
        public string selectionSource { get; set; }
        public string projectPermission { get; set; }
        public string rolePermission { get; set; }
        public string effectivePermission { get; set; }
        public string contextText { get; set; }
    }

    private sealed class JkProjectsResponse
    {
        public bool ok { get; set; }
        public string activeProjectId { get; set; }
        public JkProject[] projects { get; set; }
    }

    private sealed class JkRolesResponse
    {
        public bool ok { get; set; }
        public JkRole[] roles { get; set; }
        public JkRoleContext activeRoleContext { get; set; }
        public JkWorkflowPreset[] workflowPresets { get; set; }
    }

    private sealed class JkWorkflowPreset
    {
        public string id { get; set; }
        public string name { get; set; }
        public string preference { get; set; }
        public override string ToString() { return name ?? id; }
    }

    private sealed class JkRoleBundle
    {
        public string format { get; set; }
        public int version { get; set; }
        public long exportedAt { get; set; }
        public JkRole[] roles { get; set; }
    }

    private sealed class JkRoleExportResponse
    {
        public bool ok { get; set; }
        public JkRoleBundle bundle { get; set; }
    }

    private sealed class JkRoleMutationResponse
    {
        public bool ok { get; set; }
        public JkRole role { get; set; }
        public JkRoleContext context { get; set; }
    }

    private sealed class JkApproval
    {
        public string id { get; set; }
        public string projectId { get; set; }
        public string commandPreview { get; set; }
        public bool needsNetwork { get; set; }
        public bool destructive { get; set; }
    }

    private sealed class JkApprovalsResponse
    {
        public bool ok { get; set; }
        public JkApproval[] approvals { get; set; }
    }

    private sealed class JkExecutionResponse
    {
        public bool ok { get; set; }
        public JkExecution execution { get; set; }
    }

    private sealed class JkExecution
    {
        public string projectId { get; set; }
        public string projectName { get; set; }
        public string goal { get; set; }
        public string task { get; set; }
        public string mode { get; set; }
        public string phase { get; set; }
        public string primaryStage { get; set; }
        public string[] supportingStages { get; set; }
        public JkMassUlw massUlw { get; set; }
        public string verificationStatus { get; set; }
        public int failureCount { get; set; }
        public int completedCount { get; set; }
        public int pendingCount { get; set; }
        public string lastProgressSummary { get; set; }
        public long updatedAt { get; set; }
        public bool recoveryNeeded { get; set; }
        public bool lastVerificationFailed { get; set; }
    }

    private sealed class JkMassUlw
    {
        public long createdAt { get; set; }
        public long updatedAt { get; set; }
        public int? currentWave { get; set; }
        public JkMassUlwWave[] waves { get; set; }
        public JkMassUlwLane[] lanes { get; set; }
        public string[] runningLanes { get; set; }
        public string[] failedLanes { get; set; }
        public string[] blockedLanes { get; set; }
        public string[] blockedDependencies { get; set; }
        public string verification { get; set; }
    }

    private sealed class JkMassUlwWave
    {
        public int index { get; set; }
        public string[] laneIds { get; set; }
        public string status { get; set; }
    }

    private sealed class JkMassUlwLane
    {
        public string id { get; set; }
        public string task { get; set; }
        public string status { get; set; }
        public string[] dependsOn { get; set; }
        public int attempts { get; set; }
        public int? wave { get; set; }
    }

    private sealed class JkAuditEvent
    {
        public string type { get; set; }
        public long ts { get; set; }
        public string projectId { get; set; }
        public string detail { get; set; }
    }

    private sealed class JkLogsResponse
    {
        public bool ok { get; set; }
        public JkAuditEvent[] logs { get; set; }
    }

    private sealed class JkExecutorRunViewResponse
    {
        public bool ok { get; set; }
        public JkExecution execution { get; set; }
        public int approvalCount { get; set; }
        public JkAuditEvent[] logs { get; set; }
    }

    private sealed class JkRoleSaveRequest
    {
        public string name { get; set; }
        public string description { get; set; }
        public string instructions { get; set; }
        public string permissionPreset { get; set; }
        public string[] tools { get; set; }
        public string[] skills { get; set; }
        public string workflowPreference { get; set; }
    }

    private sealed class JkRoleSelectRequest
    {
        public string roleId { get; set; }
    }

    private sealed class JkOption
    {
        public string Value { get; set; }
        public string Label { get; set; }
        public override string ToString() { return Label ?? Value; }
    }

    private const int MaxLauncherLogFiles = 20;
    private const int MaxLauncherLogAgeDays = 14;
    private const long MaxLauncherLogFileBytes = 2L * 1024L * 1024L;
    private const long MaxLauncherLogTotalBytes = 25L * 1024L * 1024L;
    private const int MaxLauncherLogLinesAfterTrim = 2500;
    private const int MaxVisibleLogCharacters = 200000;
    private static readonly string[] LanguageCodes = new[]
    {
        "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt-BR", "it",
        "nl", "pl", "ru", "tr", "vi", "id", "th", "ar", "hi", "uk"
    };
    private static readonly string[] LanguageOptionCodes = new[]
    {
        "auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt-BR", "it",
        "nl", "pl", "ru", "tr", "vi", "id", "th", "ar", "hi", "uk"
    };
    private static readonly string[] LanguageOptionNames = new[]
    {
        "Auto (System)", "English", "한국어", "日本語", "简体中文", "繁體中文",
        "Español", "Français", "Deutsch", "Português (Brasil)", "Italiano",
        "Nederlands", "Polski", "Русский", "Türkçe", "Tiếng Việt", "Bahasa Indonesia",
        "ไทย", "العربية", "हिन्दी", "Українська"
    };
    private static readonly Dictionary<string, string[]> Texts = new Dictionary<string, string[]>
    {
        {"statusChecking", new[] {"checking...", "확인 중...", "確認中...", "正在检查...", "正在檢查...", "comprobando...", "vérification...", "wird geprüft...", "verificando...", "controllo...", "controleren...", "sprawdzanie...", "проверка...", "kontrol ediliyor...", "đang kiểm tra...", "memeriksa...", "กำลังตรวจสอบ...", "جار التحقق...", "जांच हो रही है...", "перевірка..."}},
        {"statusOn", new[] {"on", "켜짐", "オン", "开启", "開啟", "activo", "actif", "ein", "ligado", "attivo", "aan", "włączone", "вкл", "açık", "bật", "aktif", "เปิด", "تشغيل", "चालू", "увімкнено"}},
        {"statusOff", new[] {"off", "꺼짐", "オフ", "关闭", "關閉", "inactivo", "inactif", "aus", "desligado", "spento", "uit", "wyłączone", "выкл", "kapalı", "tắt", "nonaktif", "ปิด", "إيقاف", "बंद", "вимкнено"}},
        {"startMCP", new[] {"Start MCP", "MCP 시작", "MCP を開始", "启动 MCP", "啟動 MCP", "Iniciar MCP", "Démarrer MCP", "MCP starten", "Iniciar MCP", "Avvia MCP", "MCP starten", "Uruchom MCP", "Запустить MCP", "MCP başlat", "Khởi động MCP", "Mulai MCP", "เริ่ม MCP", "بدء MCP", "MCP शुरू करें", "Запустити MCP"}},
        {"stopMCP", new[] {"Stop MCP", "MCP 중지", "MCP を停止", "停止 MCP", "停止 MCP", "Detener MCP", "Arrêter MCP", "MCP stoppen", "Parar MCP", "Ferma MCP", "MCP stoppen", "Zatrzymaj MCP", "Остановить MCP", "MCP durdur", "Dừng MCP", "Hentikan MCP", "หยุด MCP", "إيقاف MCP", "MCP रोकें", "Зупинити MCP"}},
        {"restartMCP", new[] {"Restart MCP", "MCP 재시작", "MCP を再起動", "重启 MCP", "重新啟動 MCP", "Reiniciar MCP", "Redémarrer MCP", "MCP neu starten", "Reiniciar MCP", "Riavvia MCP", "MCP herstarten", "Uruchom ponownie MCP", "Перезапустить MCP", "MCP yeniden başlat", "Khởi động lại MCP", "Mulai ulang MCP", "รีสตาร์ท MCP", "إعادة تشغيل MCP", "MCP फिर शुरू करें", "Перезапустити MCP"}},
        {"settingsMenu", new[] {"Settings...", "설정...", "設定...", "设置...", "設定...", "Ajustes...", "Réglages...", "Einstellungen...", "Configurações...", "Impostazioni...", "Instellingen...", "Ustawienia...", "Настройки...", "Ayarlar...", "Cài đặt...", "Pengaturan...", "การตั้งค่า...", "الإعدادات...", "सेटिंग्स...", "Налаштування..."}},
        {"quit", new[] {"Quit", "종료", "終了", "退出", "結束", "Salir", "Quitter", "Beenden", "Sair", "Esci", "Afsluiten", "Zakończ", "Выход", "Çık", "Thoát", "Keluar", "ออก", "إنهاء", "बंद करें", "Вийти"}},
        {"settingsTitle", new[] {"JK Settings", "JK 설정", "JK 設定", "JK 设置", "JK 設定", "Ajustes de JK", "Réglages de JK", "JK Einstellungen", "Configurações do JK", "Impostazioni JK", "JK instellingen", "Ustawienia JK", "Настройки JK", "JK ayarları", "Cài đặt JK", "Pengaturan JK", "การตั้งค่า JK", "إعدادات JK", "JK सेटिंग्स", "Налаштування JK"}},
        {"language", new[] {"Language", "언어", "言語", "语言", "語言", "Idioma", "Langue", "Sprache", "Idioma", "Lingua", "Taal", "Język", "Язык", "Dil", "Ngôn ngữ", "Bahasa", "ภาษา", "اللغة", "भाषा", "Мова"}},
        {"projectFolder", new[] {"Project folder", "프로젝트 폴더", "プロジェクトフォルダ", "项目文件夹", "專案資料夾", "Carpeta del proyecto", "Dossier du projet", "Projektordner", "Pasta do projeto", "Cartella progetto", "Projectmap", "Folder projektu", "Папка проекта", "Proje klasörü", "Thư mục dự án", "Folder proyek", "โฟลเดอร์โปรเจกต์", "مجلد المشروع", "प्रोजेक्ट फ़ोल्डर", "Тека проєкту"}},
        {"browse", new[] {"Browse...", "찾아보기...", "参照...", "浏览...", "瀏覽...", "Examinar...", "Parcourir...", "Durchsuchen...", "Procurar...", "Sfoglia...", "Bladeren...", "Przeglądaj...", "Обзор...", "Gözat...", "Duyệt...", "Telusuri...", "เรียกดู...", "استعراض...", "ब्राउज़...", "Огляд..."}},
        {"launchWindowsSetting", new[] {"Launch JK when Windows starts", "Windows 시작 시 JK 실행", "Windows 起動時に JK を起動", "Windows 启动时启动 JK", "Windows 啟動時啟動 JK", "Iniciar JK con Windows", "Lancer JK au démarrage de Windows", "JK beim Windows-Start starten", "Abrir JK ao iniciar o Windows", "Avvia JK con Windows", "JK starten met Windows", "Uruchamiaj JK z Windows", "Запускать JK с Windows", "Windows açılışında JK başlat", "Mở JK cùng Windows", "Jalankan JK saat Windows mulai", "เปิด JK พร้อม Windows", "تشغيل JK عند بدء Windows", "Windows शुरू होने पर JK चलाएं", "Запускати JK з Windows"}},
        {"startOnOpenSetting", new[] {"Start MCP automatically when the app opens", "앱 열 때 MCP 자동 시작", "アプリ起動時に MCP を自動開始", "应用打开时自动启动 MCP", "App 開啟時自動啟動 MCP", "Iniciar MCP automáticamente al abrir la app", "Démarrer MCP automatiquement à l'ouverture", "MCP beim Öffnen automatisch starten", "Iniciar MCP automaticamente ao abrir o app", "Avvia MCP automaticamente all'apertura", "Start MCP automatisch bij openen", "Automatycznie uruchamiaj MCP przy otwarciu", "Автоматически запускать MCP при открытии", "Uygulama açılınca MCP otomatik başlasın", "Tự động khởi động MCP khi mở ứng dụng", "Mulai MCP otomatis saat app dibuka", "เริ่ม MCP อัตโนมัติเมื่อเปิดแอป", "بدء MCP تلقائيا عند فتح التطبيق", "ऐप खुलने पर MCP अपने-आप शुरू करें", "Автоматично запускати MCP під час відкриття"}},
        {"autoUpdatesSetting", new[] {"Check for updates automatically", "업데이트 자동 확인", "更新を自動確認", "自动检查更新", "自動檢查更新", "Buscar actualizaciones automáticamente", "Recherche automatique des mises à jour", "Automatisch nach Updates suchen", "Verificar atualizações automaticamente", "Controlla aggiornamenti automaticamente", "Automatisch updates zoeken", "Automatycznie sprawdzaj aktualizacje", "Автоматически проверять обновления", "Güncellemeleri otomatik denetle", "Tự động kiểm tra cập nhật", "Periksa pembaruan otomatis", "ตรวจอัปเดตอัตโนมัติ", "التحقق التلقائي من التحديثات", "अपडेट अपने-आप जांचें", "Автоматично перевіряти оновлення"}},
        {"publicTunnelSetting", new[] {"Enable ChatGPT web connector", "ChatGPT 웹 커넥터 사용", "ChatGPT Web コネクタを有効化", "启用 ChatGPT 网页连接器", "啟用 ChatGPT 網頁連接器", "Activar conector web de ChatGPT", "Activer le connecteur web ChatGPT", "ChatGPT-Web-Connector aktivieren", "Ativar conector web do ChatGPT", "Abilita connettore web ChatGPT", "ChatGPT-webconnector inschakelen", "Włącz konektor web ChatGPT", "Включить веб-коннектор ChatGPT", "ChatGPT web bağlayıcısını etkinleştir", "Bật trình kết nối web ChatGPT", "Aktifkan konektor web ChatGPT", "เปิดตัวเชื่อมต่อเว็บ ChatGPT", "تفعيل موصل ChatGPT على الويب", "ChatGPT वेब कनेक्टर चालू करें", "Увімкнути веб-конектор ChatGPT"}},
        {"publicHostname", new[] {"Owned fixed domain (optional)", "본인 소유 고정 도메인 (선택)", "所有する固定ドメイン (任意)", "自有固定域名（可选）", "自有固定網域（選填）", "Dominio fijo propio (opcional)", "Domaine fixe personnel (facultatif)", "Eigene feste Domain (optional)", "Domínio fixo próprio (opcional)", "Dominio fisso personale (opzionale)", "Eigen vast domein (optioneel)", "Własna stała domena (opcjonalnie)", "Собственный постоянный домен (необязательно)", "Kendi sabit alan adınız (isteğe bağlı)", "Tên miền cố định của bạn (tùy chọn)", "Domain tetap milik Anda (opsional)", "โดเมนคงที่ของคุณ (ไม่บังคับ)", "نطاق ثابت تملكه (اختياري)", "आपका स्थिर डोमेन (वैकल्पिक)", "Власний сталий домен (необов'язково)"}},
        {"publicHostnameHint", new[] {"Blank uses a temporary Quick Tunnel URL. It changes on restart, so reconnect ChatGPT. Use your own Cloudflare Named Tunnel hostname for daily use.", "비워두면 임시 Quick Tunnel URL을 씁니다. 재시작하면 주소가 바뀌므로 ChatGPT를 다시 연결해야 합니다. 상시 사용은 본인 Cloudflare Named Tunnel 호스트명을 입력하세요.", "空欄なら一時 Quick Tunnel URL を使います。再起動で変わるため ChatGPT の再接続が必要です。常用は自分の Cloudflare Named Tunnel ホスト名を入力してください。", "留空会使用临时 Quick Tunnel URL。重启后会变化，需要重新连接 ChatGPT。日常使用请输入自己的 Cloudflare Named Tunnel 主机名。", "留空會使用臨時 Quick Tunnel URL。重新啟動後會變更，需重新連接 ChatGPT。日常使用請輸入自己的 Cloudflare Named Tunnel 主機名稱。", "En blanco usa una URL temporal de Quick Tunnel. Cambia al reiniciar; vuelve a conectar ChatGPT. Para uso diario escribe tu hostname de Cloudflare Named Tunnel.", "Vide, utilise une URL Quick Tunnel temporaire. Elle change au redémarrage; reconnectez ChatGPT. Pour l'usage quotidien, indiquez votre hôte Cloudflare Named Tunnel.", "Leer nutzt eine temporäre Quick-Tunnel-URL. Sie ändert sich beim Neustart; ChatGPT neu verbinden. Für Dauerbetrieb eigene Cloudflare-Named-Tunnel-Hostname eintragen.", "Em branco usa uma URL temporária Quick Tunnel. Ela muda ao reiniciar; reconecte o ChatGPT. Para uso diário, informe seu hostname Cloudflare Named Tunnel.", "Vuoto usa un URL Quick Tunnel temporaneo. Cambia al riavvio; riconnetti ChatGPT. Per l'uso quotidiano inserisci il tuo hostname Cloudflare Named Tunnel.", "Leeg gebruikt een tijdelijke Quick Tunnel-URL. Die wijzigt na herstart; verbind ChatGPT opnieuw. Voor dagelijks gebruik vul je je Cloudflare Named Tunnel-hostnaam in.", "Puste używa tymczasowego URL Quick Tunnel. Zmienia się po restarcie; połącz ChatGPT ponownie. Do codziennego użycia wpisz własny hostname Cloudflare Named Tunnel.", "Пусто — временный URL Quick Tunnel. Он меняется при перезапуске; подключите ChatGPT заново. Для постоянной работы укажите свой hostname Cloudflare Named Tunnel.", "Boşsa geçici Quick Tunnel URL kullanır. Yeniden başlatınca değişir; ChatGPT'yi yeniden bağlayın. Günlük kullanım için kendi Cloudflare Named Tunnel hostname'inizi girin.", "Để trống sẽ dùng URL Quick Tunnel tạm thời. URL đổi khi khởi động lại; hãy kết nối lại ChatGPT. Dùng hằng ngày thì nhập hostname Cloudflare Named Tunnel của bạn.", "Kosong memakai URL Quick Tunnel sementara. URL berubah saat restart; hubungkan ulang ChatGPT. Untuk harian, isi hostname Cloudflare Named Tunnel milik Anda.", "เว้นว่างเพื่อใช้ URL Quick Tunnel ชั่วคราว ซึ่งจะเปลี่ยนเมื่อรีสตาร์ต ต้องเชื่อมต่อ ChatGPT ใหม่ ใช้งานประจำให้ใส่ hostname Cloudflare Named Tunnel ของคุณ", "فارغ يعني استخدام رابط Quick Tunnel مؤقت. يتغير عند إعادة التشغيل؛ أعد ربط ChatGPT. للاستخدام اليومي أدخل اسم مضيف Cloudflare Named Tunnel الخاص بك.", "खाली रखने पर अस्थायी Quick Tunnel URL प्रयोग होगा। रीस्टार्ट पर बदलता है; ChatGPT फिर जोड़ें। रोज़ उपयोग के लिए अपना Cloudflare Named Tunnel hostname डालें।", "Порожньо — тимчасовий URL Quick Tunnel. Після перезапуску змінюється; підключіть ChatGPT знову. Для щоденного використання вкажіть свій hostname Cloudflare Named Tunnel."}},
        {"localPort", new[] {"Local port", "로컬 포트", "ローカルポート", "本地端口", "本機連接埠", "Puerto local", "Port local", "Lokaler Port", "Porta local", "Porta locale", "Lokale poort", "Port lokalny", "Локальный порт", "Yerel bağlantı noktası", "Cổng cục bộ", "Port lokal", "พอร์ตภายใน", "المنفذ المحلي", "स्थानीय पोर्ट", "Локальний порт"}},
        {"githubRepositoryURL", new[] {"GitHub repository URL", "GitHub 저장소 URL", "GitHub リポジトリ URL", "GitHub 仓库 URL", "GitHub 儲存庫 URL", "URL del repositorio GitHub", "URL du dépôt GitHub", "GitHub-Repository-URL", "URL do repositório GitHub", "URL repository GitHub", "GitHub-repository-URL", "URL repozytorium GitHub", "URL репозитория GitHub", "GitHub depo URL'si", "URL kho GitHub", "URL repositori GitHub", "URL GitHub repository", "رابط مستودع GitHub", "GitHub रिपॉज़िटरी URL", "URL репозиторію GitHub"}},
        {"copyConnector", new[] {"Copy Connector URL", "커넥터 URL 복사", "コネクタ URL をコピー", "复制连接器 URL", "複製連接器 URL", "Copiar URL del conector", "Copier l'URL du connecteur", "Connector-URL kopieren", "Copiar URL do conector", "Copia URL connettore", "Connector-URL kopiëren", "Kopiuj URL konektora", "Копировать URL коннектора", "Bağlayıcı URL'sini kopyala", "Sao chép URL kết nối", "Salin URL konektor", "คัดลอก URL ตัวเชื่อมต่อ", "نسخ رابط الموصل", "कनेक्टर URL कॉपी करें", "Скопіювати URL конектора"}},
        {"copyOwnerToken", new[] {"Copy Owner Token", "소유자 토큰 복사", "所有者トークンをコピー", "复制所有者令牌", "複製擁有者權杖", "Copiar token de propietario", "Copier le jeton propriétaire", "Owner-Token kopieren", "Copiar token do proprietário", "Copia token proprietario", "Owner-token kopiëren", "Kopiuj token właściciela", "Копировать токен владельца", "Sahip tokenini kopyala", "Sao chép token chủ sở hữu", "Salin token pemilik", "คัดลอกโทเคนเจ้าของ", "نسخ رمز المالك", "Owner token कॉपी करें", "Скопіювати токен власника"}},
        {"autoGenerateToken", new[] {"Auto-generate Token", "토큰 자동 생성", "トークンを自動生成", "自动生成令牌", "自動產生權杖", "Generar token automáticamente", "Générer le jeton automatiquement", "Token automatisch erzeugen", "Gerar token automaticamente", "Genera token automaticamente", "Token automatisch genereren", "Automatycznie wygeneruj token", "Автоматически создать токен", "Tokeni otomatik oluştur", "Tự động tạo token", "Buat token otomatis", "สร้างโทเคนอัตโนมัติ", "إنشاء الرمز تلقائيا", "Token अपने-आप बनाएं", "Автоматично створити токен"}},
        {"openLocalHealth", new[] {"Open Local Health", "로컬 상태 열기", "ローカルヘルスを開く", "打开本地健康检查", "開啟本機健康檢查", "Abrir estado local", "Ouvrir l'état local", "Lokalen Status öffnen", "Abrir saúde local", "Apri stato locale", "Lokale status openen", "Otwórz status lokalny", "Открыть локальный статус", "Yerel durumu aç", "Mở trạng thái cục bộ", "Buka kesehatan lokal", "เปิดสถานะภายใน", "فتح حالة الجهاز", "स्थानीय हेल्थ खोलें", "Відкрити локальний стан"}},
        {"openPublicHealth", new[] {"Open Public Health", "공개 상태 열기", "公開ヘルスを開く", "打开公开健康检查", "開啟公開健康檢查", "Abrir estado público", "Ouvrir l'état public", "Öffentlichen Status öffnen", "Abrir saúde pública", "Apri stato pubblico", "Publieke status openen", "Otwórz status publiczny", "Открыть публичный статус", "Genel durumu aç", "Mở trạng thái công khai", "Buka kesehatan publik", "เปิดสถานะสาธารณะ", "فتح الحالة العامة", "सार्वजनिक हेल्थ खोलें", "Відкрити публічний стан"}},
        {"showLogs", new[] {"Show Logs", "로그 보기", "ログを表示", "显示日志", "顯示日誌", "Mostrar registros", "Afficher les journaux", "Logs anzeigen", "Mostrar logs", "Mostra log", "Logs tonen", "Pokaż logi", "Показать журналы", "Günlükleri göster", "Hiện nhật ký", "Tampilkan log", "แสดงบันทึก", "عرض السجلات", "लॉग दिखाएं", "Показати журнали"}},
        {"openGithub", new[] {"Open GitHub Repository", "GitHub 저장소 열기", "GitHub リポジトリを開く", "打开 GitHub 仓库", "開啟 GitHub 儲存庫", "Abrir repositorio GitHub", "Ouvrir le dépôt GitHub", "GitHub-Repository öffnen", "Abrir repositório GitHub", "Apri repository GitHub", "GitHub-repository openen", "Otwórz repozytorium GitHub", "Открыть репозиторий GitHub", "GitHub deposunu aç", "Mở kho GitHub", "Buka repositori GitHub", "เปิด GitHub repository", "فتح مستودع GitHub", "GitHub रिपॉज़िटरी खोलें", "Відкрити репозиторій GitHub"}},
        {"checkUpdates", new[] {"Check for Updates...", "업데이트 확인...", "更新を確認...", "检查更新...", "檢查更新..."}},
        {"about", new[] {"About JK", "JK 정보", "JK について", "关于 JK", "關於 JK"}},
        {"save", new[] {"Save", "저장", "保存", "保存", "儲存", "Guardar", "Enregistrer", "Speichern", "Salvar", "Salva", "Opslaan", "Zapisz", "Сохранить", "Kaydet", "Lưu", "Simpan", "บันทึก", "حفظ", "सहेजें", "Зберегти"}},
        {"cancel", new[] {"Cancel", "취소", "キャンセル", "取消", "取消", "Cancelar", "Annuler", "Abbrechen", "Cancelar", "Annulla", "Annuleren", "Anuluj", "Отмена", "İptal", "Hủy", "Batal", "ยกเลิก", "إلغاء", "रद्द करें", "Скасувати"}},
        {"connectorUrlLabel", new[] {"connector URL", "커넥터 URL"}},
        {"ownerTokenLabel", new[] {"owner token", "소유자 토큰"}},
        {"launcherTitle", new[] {"Launcher", "런처"}},
        {"connectorCaption", new[] {"ChatGPT connector URL", "ChatGPT 커넥터 URL"}},
        {"ownerTokenCaption", new[] {"Owner token", "소유자 토큰"}},
        {"connectorHintDefault", new[] {"Paste this into ChatGPT › Apps & Connectors, then log in with the owner token.", "ChatGPT › Apps & Connectors에 붙여넣고, 로그인 창에 소유자 토큰을 입력하세요."}},
        {"connectorHintTemporary", new[] {"Temporary address: it changes every time JK restarts. Use your own domain for a permanent URL.", "임시 주소입니다. JK를 재시작하면 바뀝니다. 고정 주소가 필요하면 본인 도메인을 설정하세요."}},
        {"activityCaption", new[] {"Activity", "활동 로그"}},
        {"statusRunning", new[] {"Running", "실행 중"}},
        {"statusStopped", new[] {"Stopped", "중지됨"}},
        {"copiedItem", new[] {"Copied {0}.", "{0} 복사 완료."}},
        {"copyFailedManual", new[] {"Copy failed. Select the {0} field manually.", "복사에 실패했습니다. {0} 입력칸을 직접 선택해 복사하세요."}},
        {"ownerTokenGenerating", new[] {"Auto-generating owner token...", "소유자 토큰 자동 생성 중..."}},
        {"ownerTokenConfigured", new[] {"Owner token already configured. Click Auto-generate Token to create/copy a new one.", "소유자 토큰이 이미 설정되어 있습니다. 새 토큰이 필요하면 토큰 자동 생성을 누르세요."}},
        {"ownerTokenReadyCopied", new[] {"Owner token ready and copied. Paste it into ChatGPT when prompted.", "소유자 토큰 생성 및 복사 완료. ChatGPT가 요청하면 붙여넣으세요."}},
        {"ownerTokenReadyManualCopy", new[] {"Owner token is ready, but clipboard copy failed. The field is selected for manual copy.", "소유자 토큰은 생성됐지만 클립보드 복사에 실패했습니다. 입력칸을 선택해 두었으니 직접 복사하세요."}},
        {"ownerTokenNotReady", new[] {"Owner token is not ready yet. Click Auto-generate Token first.", "소유자 토큰이 아직 준비되지 않았습니다. 먼저 토큰 자동 생성을 누르세요."}},
        {"temporaryTunnelReady", new[] {"Temporary tunnel URL ready. It changes when the tunnel restarts.", "임시 터널 URL 준비 완료. 터널을 재시작하면 주소가 바뀝니다."}},
        {"temporaryTunnelChanged", new[] {"Temporary tunnel URL changed. Reconnect or update the ChatGPT app registration.", "임시 터널 URL이 변경되었습니다. ChatGPT 앱 등록을 다시 연결하거나 업데이트하세요."}},
        {"temporaryTunnelCopied", new[] {"Temporary connector URL copied. For permanent use, configure a stable domain before registering in ChatGPT.", "임시 커넥터 URL 복사 완료. 상시 사용하려면 ChatGPT 등록 전에 고정 도메인을 설정하세요."}},
        {"stableConnectorReady", new[] {"Ready: {0}", "준비됨: {0}"}}
    };
    private readonly string[] args;
    private readonly bool disableTunnelForLaunch;
    private readonly string root;
    private readonly string appDataDir;
    private readonly string logDir;
    private readonly string logFile;
    private readonly string selectedProjectFile;
    private readonly string settingsFile;
    private readonly string defaultWorkspace;
    private string configuredPublicHost;
    private string lastConnectorUrl;
    private int port;
    private string preferredLanguage = "auto";
    private string githubRepoUrl;
    private bool publicTunnelEnabled;
    private bool launchAtStartup;
    private bool startMcpOnOpen;
    private bool autoCheckUpdates;
    private readonly TextBox logBox;
    private readonly TextBox urlBox;
    private readonly TextBox ownerTokenBox;
    private readonly Label statusLabel;
    private readonly Panel dashboardPanel;
    private readonly Panel contentHost;
    private readonly Label dashboardProjectValue;
    private readonly Label dashboardRoleValue;
    private readonly Label dashboardModeValue;
    private readonly Label dashboardSkillsValue;
    private readonly Button copyButton;
    private readonly Button copyOwnerTokenButton;
    private readonly Button autoGenerateOwnerTokenButton;
    private readonly Button stopButton;
    private readonly Button openLogButton;
    private readonly NotifyIcon trayIcon;
    private readonly ContextMenuStrip trayMenu;
    private readonly ToolStripMenuItem statusTrayItem;
    private readonly ToolStripMenuItem toggleTrayItem;
    private readonly ToolStripMenuItem restartTrayItem;
    private readonly ToolStripMenuItem settingsTrayItem;
    private readonly ToolStripMenuItem quitTrayItem;
    private Process process;
    private string mcpUrl;
    private string ownerToken;
    private string pendingSecretKind;
    private string selectedProjectPath;
    private bool stopping;
    private bool exitRequested;
    private bool trayNoticeShown;
    private bool dashboardOpenScheduled;
    private JkProject[] cachedProjects = new JkProject[0];
    private JkRole[] cachedRoles = new JkRole[0];
    private JkWorkflowPreset[] cachedWorkflowPresets = new JkWorkflowPreset[0];
    private readonly HashSet<string> visibleApprovalIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private int visibleRemoteApprovalCount;
    private bool approvalPollBusy;
    private Timer approvalPollTimer;
    private Timer runPollTimer;
    private Panel runsPanel;
    private Label runConnectionValue;
    private Label runGoalValue;
    private Label runTaskValue;
    private Label runMetaValue;
    private Label runWaitValue;
    private Label runDagValue;
    private Panel runLaneFlow;
    private ListView runEventList;
    private bool runsPageVisible;
    private bool runRefreshBusy;
    private bool dashboardRoleRefreshBusy;
    private bool updateCheckBusy;
    private JkMassUlw renderedRunMass;
    private string consoleProjectId;
    private JkRoleContext cachedRoleContext;
    private static readonly System.Drawing.Color JkSidebar = System.Drawing.Color.FromArgb(17, 19, 24);
    private static readonly System.Drawing.Color JkSidebarHover = System.Drawing.Color.FromArgb(30, 33, 41);
    private static readonly System.Drawing.Color JkSidebarActive = System.Drawing.Color.FromArgb(38, 42, 52);
    private static readonly System.Drawing.Color JkCanvas = System.Drawing.Color.FromArgb(245, 246, 248);
    private static readonly System.Drawing.Color JkSurface = System.Drawing.Color.White;
    private static readonly System.Drawing.Color JkSurfaceAlt = System.Drawing.Color.FromArgb(243, 244, 247);
    private static readonly System.Drawing.Color JkText = System.Drawing.Color.FromArgb(17, 24, 39);
    private static readonly System.Drawing.Color JkMuted = System.Drawing.Color.FromArgb(107, 114, 128);
    private static readonly System.Drawing.Color JkAccent = System.Drawing.Color.FromArgb(201, 166, 107);
    private static readonly System.Drawing.Color JkAccentHover = System.Drawing.Color.FromArgb(214, 182, 128);
    private static readonly System.Drawing.Color JkAccentText = System.Drawing.Color.FromArgb(38, 29, 14);
    private static readonly System.Drawing.Color JkBorder = System.Drawing.Color.FromArgb(228, 231, 236);
    private static readonly System.Drawing.Color JkConsole = System.Drawing.Color.FromArgb(17, 19, 24);
    private static readonly System.Drawing.Color JkSuccess = System.Drawing.Color.FromArgb(22, 163, 74);
    private static readonly System.Drawing.Color JkWarning = System.Drawing.Color.FromArgb(180, 110, 20);
    private bool uiPreview;
    private Label statusPill;
    private Label connectorHint;
    private readonly List<Button> navButtons = new List<Button>();
    private bool autoGenerateOwnerTokenOnNextStart;

    internal LauncherForm(string[] args)
    {
        this.args = args;
        disableTunnelForLaunch = Array.Exists(args, value => IsOption(value, "-NoTunnel"));
        uiPreview = Array.Exists(args, value => string.Equals(value, "--ui-preview", StringComparison.OrdinalIgnoreCase));
        root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        appDataDir = uiPreview
            ? Path.Combine(Path.GetTempPath(), "JK-ui-preview")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JK");
        logDir = Path.Combine(appDataDir, "logs");
        selectedProjectFile = Path.Combine(appDataDir, "selected-project.txt");
        settingsFile = Path.Combine(appDataDir, "settings.ini");
        defaultWorkspace = ResolveDefaultWorkspace();
        configuredPublicHost = ResolveConfiguredPublicHost();
        port = ResolvePort();
        publicTunnelEnabled = false;
        githubRepoUrl = GetEnvironmentValue("JK_UPDATE_REPO_URL", "CHATGPT2CODEX_UPDATE_REPO_URL");
        if (string.IsNullOrWhiteSpace(githubRepoUrl)) githubRepoUrl = "https://github.com/Anjingyeong/jk-mcp";
        LoadSettings();
        if (string.IsNullOrEmpty(selectedProjectPath)) selectedProjectPath = LoadSelectedProjectPath();
        if (!uiPreview && MigrateLegacyExecutorStartupIntent())
        {
            launchAtStartup = true;
            startMcpOnOpen = true;
            SaveSettings();
        }
        Directory.CreateDirectory(logDir);
        PruneLauncherLogs(logDir);
        logFile = Path.Combine(logDir, "launcher-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");

        Text = "JK";
        Width = 1200;
        Height = 800;
        MinimumSize = new System.Drawing.Size(1020, 700);
        StartPosition = FormStartPosition.CenterScreen;
        SetWindowIcon(this);
        BackColor = JkCanvas;
        Font = UiFont(9.5f);
        DoubleBuffered = true;

        statusLabel = new Label();
        statusLabel.Text = "JK: " + L("statusChecking");
        statusLabel.Dock = DockStyle.Fill;
        statusLabel.AutoEllipsis = true;
        statusLabel.BackColor = JkCanvas;
        statusLabel.ForeColor = JkMuted;
        statusLabel.Font = UiFont(9.75f);
        statusLabel.Padding = new Padding(1, 2, 0, 0);

        logBox = new TextBox();
        logBox.Dock = DockStyle.Fill;
        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Vertical;
        logBox.WordWrap = false;
        logBox.Font = MonoFont(9.5f);
        logBox.BorderStyle = BorderStyle.None;
        logBox.BackColor = JkConsole;
        logBox.ForeColor = System.Drawing.Color.FromArgb(203, 213, 225);
        logBox.HandleCreated += delegate { UseDarkScrollbars(logBox.Handle); };

        urlBox = new TextBox();
        urlBox.ReadOnly = true;
        urlBox.Text = "Connector URL will appear here";
        urlBox.BorderStyle = BorderStyle.None;
        urlBox.BackColor = JkSurfaceAlt;
        urlBox.ForeColor = JkText;
        urlBox.Font = MonoFont(10.5f);
        urlBox.Dock = DockStyle.Fill;
        urlBox.TextChanged += delegate { UpdateConnectorHint(); };

        copyButton = new Button();
        copyButton.Text = L("copyConnector");
        copyButton.Enabled = false;
        copyButton.Click += delegate { CopyMcpUrl(); };
        StyleActionButton(copyButton, true);

        var openDashboardButton = new Button();
        openDashboardButton.Text = "Control Center";
        openDashboardButton.Click += delegate { OpenUrl(ControlCenterUrl()); };
        StyleActionButton(openDashboardButton, true);

        ownerTokenBox = new TextBox();
        ownerTokenBox.ReadOnly = true;
        ownerTokenBox.Text = "Owner token will be auto-generated and copied on first setup";
        ownerTokenBox.BorderStyle = BorderStyle.None;
        ownerTokenBox.BackColor = JkSurfaceAlt;
        ownerTokenBox.ForeColor = JkText;
        ownerTokenBox.Font = UiFont(9.75f);
        ownerTokenBox.Dock = DockStyle.Fill;

        copyOwnerTokenButton = new Button();
        copyOwnerTokenButton.Text = L("copyOwnerToken");
        copyOwnerTokenButton.Enabled = false;
        copyOwnerTokenButton.Click += delegate { CopyOwnerToken(); };
        StyleActionButton(copyOwnerTokenButton, false);

        autoGenerateOwnerTokenButton = new Button();
        autoGenerateOwnerTokenButton.Text = L("autoGenerateToken");
        autoGenerateOwnerTokenButton.Click += delegate { AutoGenerateOwnerToken(); };
        StyleActionButton(autoGenerateOwnerTokenButton, false);

        openLogButton = new Button();
        openLogButton.Text = L("showLogs");
        openLogButton.Click += delegate { ShowLogs(); };
        StyleActionButton(openLogButton, false);

        stopButton = new Button();
        stopButton.Text = L("stopMCP");
        stopButton.Click += delegate { ToggleServer(); };
        StyleActionButton(stopButton, false);

        foreach (var action in new[] { copyButton, openDashboardButton, copyOwnerTokenButton, autoGenerateOwnerTokenButton, openLogButton, stopButton })
        {
            action.Height = 38;
            action.Width = Math.Max(118, TextRenderer.MeasureText(action.Text, action.Font).Width + 40);
            action.Margin = new Padding(10, 0, 0, 0);
        }
        openDashboardButton.Margin = new Padding(0, 0, 0, 0);

        // Header: page title + live status text, status pill on the right.
        var header = new TableLayoutPanel();
        header.Dock = DockStyle.Fill;
        header.ColumnCount = 2;
        header.RowCount = 2;
        header.BackColor = JkCanvas;
        header.Margin = new Padding(0, 0, 0, 10);
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        header.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        header.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var pageTitle = new Label();
        pageTitle.Text = L("launcherTitle");
        pageTitle.Dock = DockStyle.Fill;
        pageTitle.Font = UiSemibold(17f);
        pageTitle.ForeColor = JkText;
        pageTitle.BackColor = JkCanvas;
        statusPill = new JkPill();
        statusPill.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        statusPill.Size = new System.Drawing.Size(128, 30);
        statusPill.Margin = new Padding(0, 4, 0, 0);
        statusPill.Font = UiSemibold(9f);
        statusPill.BackColor = JkCanvas;
        header.Controls.Add(pageTitle, 0, 0);
        header.Controls.Add(statusLabel, 0, 1);
        header.Controls.Add(statusPill, 1, 0);
        header.SetRowSpan(statusPill, 2);

        // Connection card: the two things every user needs to copy into ChatGPT.
        var connectionCard = NewCard(JkSurface);
        var connection = new TableLayoutPanel();
        connection.Dock = DockStyle.Fill;
        connection.BackColor = JkSurface;
        connection.ColumnCount = 3;
        connection.RowCount = 5;
        connection.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        connection.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        connection.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        connection.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
        connection.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        connection.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        connection.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
        connection.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        connection.Controls.Add(NewCaption(L("connectorCaption"), JkSurface), 0, 0);
        connection.SetColumnSpan(connection.GetControlFromPosition(0, 0), 3);
        connection.Controls.Add(NewField(urlBox), 0, 1);
        connection.Controls.Add(copyButton, 1, 1);
        connection.SetColumnSpan(copyButton, 2);
        connectorHint = new Label();
        connectorHint.Dock = DockStyle.Fill;
        connectorHint.BackColor = JkSurface;
        connectorHint.ForeColor = JkMuted;
        connectorHint.Font = UiFont(9f);
        connectorHint.Padding = new Padding(1, 6, 0, 0);
        connectorHint.AutoEllipsis = true;
        connection.Controls.Add(connectorHint, 0, 2);
        connection.SetColumnSpan(connectorHint, 3);
        connection.Controls.Add(NewCaption(L("ownerTokenCaption"), JkSurface), 0, 3);
        connection.SetColumnSpan(connection.GetControlFromPosition(0, 3), 3);
        connection.Controls.Add(NewField(ownerTokenBox), 0, 4);
        connection.Controls.Add(copyOwnerTokenButton, 1, 4);
        connection.Controls.Add(autoGenerateOwnerTokenButton, 2, 4);
        connectionCard.Controls.Add(connection);
        UpdateConnectorHint();

        // Summary: four compact stat cards.
        var summaryPanel = new TableLayoutPanel();
        summaryPanel.Dock = DockStyle.Fill;
        summaryPanel.ColumnCount = 4;
        summaryPanel.RowCount = 1;
        summaryPanel.BackColor = JkCanvas;
        summaryPanel.Margin = new Padding(0, 0, 0, 14);
        for (var column = 0; column < 4; column++) summaryPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        summaryPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        dashboardProjectValue = NewSummaryValue("—");
        dashboardRoleValue = NewSummaryValue("Default");
        dashboardModeValue = NewSummaryValue("—");
        dashboardSkillsValue = NewSummaryValue("—");
        var summaryTitles = new[] { "PROJECT", "ROLE", "MODE", "SKILLS" };
        var summaryValues = new[] { dashboardProjectValue, dashboardRoleValue, dashboardModeValue, dashboardSkillsValue };
        for (var column = 0; column < 4; column++)
        {
            var stat = NewCard(JkSurface);
            stat.Margin = new Padding(column == 0 ? 0 : 7, 0, column == 3 ? 0 : 7, 0);
            stat.Padding = new Padding(16, 12, 16, 10);
            var statTitle = NewSummaryTitle(summaryTitles[column]);
            statTitle.Dock = DockStyle.Top;
            statTitle.Height = 20;
            stat.Controls.Add(summaryValues[column]);
            stat.Controls.Add(statTitle);
            summaryPanel.Controls.Add(stat, column, 0);
        }

        // Primary actions.
        var actions = new FlowLayoutPanel();
        actions.Dock = DockStyle.Fill;
        actions.FlowDirection = FlowDirection.LeftToRight;
        actions.WrapContents = false;
        actions.BackColor = JkCanvas;
        actions.Margin = new Padding(0, 0, 0, 14);
        actions.Controls.Add(openDashboardButton);
        actions.Controls.Add(stopButton);
        actions.Controls.Add(openLogButton);

        // Activity log in a dark rounded card.
        var logCard = NewCard(JkConsole);
        logCard.BorderColor = JkConsole;
        logCard.Padding = new Padding(18, 12, 10, 12);
        logCard.Margin = new Padding(0);
        var logCaption = NewCaption(L("activityCaption"), JkConsole);
        logCaption.ForeColor = System.Drawing.Color.FromArgb(148, 163, 184);
        logCaption.Dock = DockStyle.Top;
        logCaption.Height = 26;
        logCard.Controls.Add(logBox);
        logCard.Controls.Add(logCaption);

        var layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Fill;
        layout.ColumnCount = 1;
        layout.RowCount = 5;
        layout.Padding = new Padding(28, 20, 28, 24);
        layout.BackColor = JkCanvas;
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 74));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 218));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 92));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(header, 0, 0);
        layout.Controls.Add(connectionCard, 0, 1);
        layout.Controls.Add(summaryPanel, 0, 2);
        layout.Controls.Add(actions, 0, 3);
        layout.Controls.Add(logCard, 0, 4);

        dashboardPanel = new Panel();
        dashboardPanel.Dock = DockStyle.Fill;
        dashboardPanel.BackColor = JkCanvas;
        dashboardPanel.Controls.Add(layout);
        runsPanel = BuildRunsPanel();

        contentHost = new Panel();
        contentHost.Dock = DockStyle.Fill;
        contentHost.BackColor = JkCanvas;
        contentHost.Controls.Add(dashboardPanel);

        var sidebar = new Panel();
        sidebar.Dock = DockStyle.Left;
        sidebar.Width = 220;
        sidebar.BackColor = JkSidebar;

        var brandLogo = new PictureBox();
        brandLogo.SetBounds(22, 22, 36, 36);
        brandLogo.SizeMode = PictureBoxSizeMode.Zoom;
        brandLogo.BackColor = JkSidebar;
        try
        {
            brandLogo.Image = BuildSidebarBrandImage();
        }
        catch
        {
            brandLogo.Image = BuildSidebarBrandImage(System.Drawing.SystemIcons.Application);
        }
        sidebar.Controls.Add(brandLogo);

        var brand = new Label();
        brand.Text = "JK";
        brand.Font = UiSemibold(15f);
        brand.ForeColor = System.Drawing.Color.White;
        brand.BackColor = JkSidebar;
        brand.SetBounds(68, 18, 120, 26);
        sidebar.Controls.Add(brand);

        var brandSubtitle = new Label();
        brandSubtitle.Text = "Runtime Console";
        brandSubtitle.Font = UiFont(8.5f);
        brandSubtitle.ForeColor = System.Drawing.Color.FromArgb(139, 148, 163);
        brandSubtitle.BackColor = JkSidebar;
        brandSubtitle.SetBounds(69, 42, 130, 18);
        sidebar.Controls.Add(brandSubtitle);

        var dashboardNav = NewNavigationButton("Launcher", 82);
        dashboardNav.Click += delegate { SetActiveNav(dashboardNav); ShowDashboardPage(); };
        sidebar.Controls.Add(dashboardNav);
        var runsNav = NewNavigationButton("Runs", 126);
        runsNav.Click += delegate { SetActiveNav(runsNav); ShowRunsPage(); };
        sidebar.Controls.Add(runsNav);
        var approvalsNav = NewNavigationButton("Approvals", 170);
        approvalsNav.Click += delegate { OpenUrl(ApprovalsPageUrl()); };
        sidebar.Controls.Add(approvalsNav);
        var controlCenterNav = NewNavigationButton("Dashboard", 214);
        controlCenterNav.Click += delegate { OpenUrl(ControlCenterUrl()); };
        sidebar.Controls.Add(controlCenterNav);
        var updatesNav = NewNavigationButton("Updates", 258);
        updatesNav.Click += delegate { CheckUpdates(true); };
        sidebar.Controls.Add(updatesNav);
        var settingsNav = NewNavigationButton("Settings", 302);
        settingsNav.Click += delegate { ShowSettings(); };
        sidebar.Controls.Add(settingsNav);
        SetNavGlyph(dashboardNav, "\uE80F");
        SetNavGlyph(runsNav, "\uE768");
        SetNavGlyph(approvalsNav, "\uE73E");
        SetNavGlyph(controlCenterNav, "\uE8A7");
        SetNavGlyph(updatesNav, "\uE896");
        SetNavGlyph(settingsNav, "\uE713");
        navButtons.AddRange(new Button[] { dashboardNav, runsNav, approvalsNav, controlCenterNav, updatesNav, settingsNav });
        SetActiveNav(dashboardNav);

        var sidebarDivider = new Panel();
        sidebarDivider.Dock = DockStyle.Right;
        sidebarDivider.Width = 1;
        sidebarDivider.BackColor = System.Drawing.Color.FromArgb(34, 37, 45);
        sidebar.Controls.Add(sidebarDivider);

        Controls.Add(contentHost);
        Controls.Add(sidebar);

        trayMenu = new ContextMenuStrip();
        statusTrayItem = new ToolStripMenuItem("JK: " + L("statusChecking"));
        statusTrayItem.Enabled = false;
        var controlCenterTrayItem = new ToolStripMenuItem("Open Control Center", null, delegate { OpenUrl(ControlCenterUrl()); });
        var approvalsTrayItem = new ToolStripMenuItem("Approvals", null, delegate { OpenUrl(ApprovalsPageUrl()); });
        toggleTrayItem = new ToolStripMenuItem(L("startMCP"), null, delegate { ToggleServer(); });
        restartTrayItem = new ToolStripMenuItem(L("restartMCP"), null, delegate { RestartServer(); });
        settingsTrayItem = new ToolStripMenuItem(L("settingsMenu"), null, delegate { ShowSettings(); });
        quitTrayItem = new ToolStripMenuItem(L("quit"), null, delegate { ExitApplication(); });
        trayMenu.Items.Add(statusTrayItem);
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add(controlCenterTrayItem);
        trayMenu.Items.Add(approvalsTrayItem);
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add(toggleTrayItem);
        trayMenu.Items.Add(restartTrayItem);
        trayMenu.Items.Add(settingsTrayItem);
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add(quitTrayItem);

        trayIcon = new NotifyIcon();
        trayIcon.Text = "JK";
        trayIcon.Icon = Icon == null ? System.Drawing.SystemIcons.Application : Icon;
        trayIcon.ContextMenuStrip = trayMenu;
        trayIcon.Visible = true;
        trayIcon.DoubleClick += delegate { ShowFromTray(); };
        trayIcon.BalloonTipClicked += delegate { OpenUrl(ApprovalsPageUrl()); };
        RefreshTrayState();

        Shown += delegate
        {
            if (uiPreview)
            {
                ShowUiPreviewState();
                if (Array.Exists(args, value => string.Equals(value, "--ui-preview-runs", StringComparison.OrdinalIgnoreCase)))
                {
                    SetActiveNav(navButtons[1]);
                    ShowConsolePage(runsPanel);
                }
                return;
            }
            if (startMcpOnOpen || args.Length > 0)
            {
                StartLauncher();
                OpenControlCenterWhenReady();
                var roleSummaryAttempts = 0;
                var roleSummaryTimer = new Timer();
                roleSummaryTimer.Interval = 1000;
                roleSummaryTimer.Tick += delegate
                {
                    roleSummaryAttempts++;
                    RefreshDashboardRoleSummary();
                    if (cachedRoleContext != null || roleSummaryAttempts >= 5)
                    {
                        roleSummaryTimer.Stop();
                        roleSummaryTimer.Dispose();
                    }
                };
                roleSummaryTimer.Start();
            }
            else
            {
                statusLabel.Text = "JK: " + L("statusOff");
                RefreshTrayState();
            }
            RefreshDashboardRoleSummary();
            StartApprovalPolling();
            StartRunPolling();
            if (autoCheckUpdates) CheckUpdates(false);
        };
        Resize += delegate
        {
            if (WindowState == FormWindowState.Minimized) HideToTray();
        };
        FormClosing += OnFormClosing;
        FormClosed += delegate
        {
            if (approvalPollTimer != null)
            {
                approvalPollTimer.Stop();
                approvalPollTimer.Dispose();
                approvalPollTimer = null;
            }
            if (runPollTimer != null)
            {
                runPollTimer.Stop();
                runPollTimer.Dispose();
                runPollTimer = null;
            }
            trayIcon.Visible = false;
            trayIcon.Dispose();
            trayMenu.Dispose();
        };
    }

    private static string Quote(string value)
    {
        if (string.IsNullOrEmpty(value)) return "\"\"";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static void SetWindowIcon(Form form)
    {
        try
        {
            var icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (icon != null) form.Icon = icon;
        }
        catch
        {
            // The embedded icon is used when present; the app can still run without it.
        }
    }

    private static string JoinArgs(string[] values)
    {
        var builder = new StringBuilder();
        for (var i = 0; i < values.Length; i++)
        {
            if (i > 0) builder.Append(' ');
            builder.Append(Quote(values[i]));
        }
        return builder.ToString();
    }

    private static bool IsOption(string value, string option)
    {
        return string.Equals(value, option, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(value, "/" + option.TrimStart('-'), StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveLanguageCode(string value)
    {
        var raw = !string.IsNullOrWhiteSpace(value) && !string.Equals(value, "auto", StringComparison.OrdinalIgnoreCase)
            ? value
            : System.Globalization.CultureInfo.CurrentUICulture.Name;
        var lower = raw.ToLowerInvariant();
        if (lower.StartsWith("zh-hant") || lower.StartsWith("zh-tw") || lower.StartsWith("zh-hk") || lower.StartsWith("zh-mo")) return "zh-Hant";
        if (lower.StartsWith("zh")) return "zh-Hans";
        if (lower.StartsWith("pt")) return "pt-BR";
        foreach (var code in LanguageCodes)
        {
            var exact = code.ToLowerInvariant();
            var prefix = exact.Split('-')[0];
            if (lower == exact || lower.StartsWith(prefix + "-")) return code;
        }
        return "en";
    }

    private string L(string key)
    {
        string[] row;
        if (!Texts.TryGetValue(key, out row) || row == null || row.Length == 0) return key;
        var code = ResolveLanguageCode(preferredLanguage);
        var index = Array.IndexOf(LanguageCodes, code);
        if (index < 0 || index >= row.Length || string.IsNullOrEmpty(row[index])) return row[0];
        return row[index];
    }

    private string LFormat(string key, params object[] args)
    {
        return string.Format(System.Globalization.CultureInfo.CurrentUICulture, L(key), args);
    }

    private int LanguageOptionIndex()
    {
        var index = Array.IndexOf(LanguageOptionCodes, preferredLanguage ?? "auto");
        return index < 0 ? 0 : index;
    }

    private string GetArgValue(string option)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (IsOption(args[i], option)) return args[i + 1];
        }
        return null;
    }

    private string ResolveDefaultWorkspace()
    {
        var value = GetArgValue("-Workspace");
        if (string.IsNullOrWhiteSpace(value)) value = GetEnvironmentValue("JK_WORKSPACE", "CHATGPT2CODEX_WORKSPACE");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("WORKSPACE");
        if (string.IsNullOrWhiteSpace(value))
        {
            value = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "workspace");
        }
        return Path.GetFullPath(value);
    }

    private int ResolvePort()
    {
        var value = GetArgValue("-Port");
        if (string.IsNullOrWhiteSpace(value)) value = GetEnvironmentValue("JK_PORT", "CHATGPT2CODEX_PORT");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("PORT");
        int parsed;
        return int.TryParse(value, out parsed) && parsed > 0 ? parsed : 7979;
    }

    private string ResolveConfiguredPublicHost()
    {
        var value = GetArgValue("-PublicHostname");
        if (string.IsNullOrWhiteSpace(value)) value = GetEnvironmentValue("JK_PUBLIC_HOSTNAME", "CHATGPT2CODEX_PUBLIC_HOSTNAME");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("PUBLIC_HOSTNAME");
        return NormalizePublicHost(value);
    }

    private static string NormalizePublicHost(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        value = value.Trim();
        Uri uri;
        if (Uri.TryCreate(value, UriKind.Absolute, out uri)) return uri.Host;
        return value.TrimEnd('/');
    }

    private string LoadSelectedProjectPath()
    {
        try
        {
            if (!File.Exists(selectedProjectFile)) return null;
            var value = File.ReadAllText(selectedProjectFile, Encoding.UTF8).Trim();
            if (value.Length == 0) return null;
            value = Path.GetFullPath(value);
            return Directory.Exists(value) ? value : null;
        }
        catch
        {
            return null;
        }
    }

    private static string EncodeSetting(string value)
    {
        if (value == null) value = string.Empty;
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    }

    private static string DecodeSetting(string value)
    {
        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(value ?? string.Empty));
        }
        catch
        {
            return string.Empty;
        }
    }

    private static bool ParseBool(string value)
    {
        return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);
    }

    private void LoadSettings()
    {
        try
        {
            if (!File.Exists(settingsFile)) return;
            foreach (var rawLine in File.ReadAllLines(settingsFile, Encoding.UTF8))
            {
                var index = rawLine.IndexOf('=');
                if (index <= 0) continue;
                var key = rawLine.Substring(0, index);
                var value = DecodeSetting(rawLine.Substring(index + 1));
                int parsedPort;
                if (key == "ProjectFolder" && Directory.Exists(value)) selectedProjectPath = Path.GetFullPath(value);
                else if (key == "Port" && int.TryParse(value, out parsedPort) && parsedPort > 0) port = parsedPort;
                else if (key == "PublicHostname") configuredPublicHost = NormalizePublicHost(value);
                else if (key == "EnablePublicTunnel") publicTunnelEnabled = ParseBool(value);
                else if (key == "LaunchAtStartup") launchAtStartup = ParseBool(value);
                else if (key == "StartMcpOnOpen") startMcpOnOpen = ParseBool(value);
                else if (key == "AutoCheckUpdates") autoCheckUpdates = ParseBool(value);
                else if (key == "GitHubRepoUrl" && !string.IsNullOrWhiteSpace(value)) githubRepoUrl = value.Trim();
                else if (key == "Language" && !string.IsNullOrWhiteSpace(value)) preferredLanguage = value.Trim();
                else if (key == "LastConnectorUrl" && !string.IsNullOrWhiteSpace(value)) lastConnectorUrl = value.Trim();
            }
        }
        catch
        {
            // Corrupt settings should not block startup.
        }

        if (GetEnvironmentValue("JK_EXPOSE_WEB", "CHATGPT2CODEX_EXPOSE_WEB") == "1" ||
            !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("PUBLIC_HOSTNAME")) ||
            !string.IsNullOrWhiteSpace(GetEnvironmentValue("JK_PUBLIC_HOSTNAME", "CHATGPT2CODEX_PUBLIC_HOSTNAME")))
        {
            publicTunnelEnabled = true;
        }
    }

    private void SaveSettings()
    {
        Directory.CreateDirectory(appDataDir);
        var lines = new[]
        {
            "ProjectFolder=" + EncodeSetting(selectedProjectPath ?? string.Empty),
            "Port=" + EncodeSetting(port.ToString()),
            "PublicHostname=" + EncodeSetting(configuredPublicHost ?? string.Empty),
            "EnablePublicTunnel=" + EncodeSetting(publicTunnelEnabled ? "true" : "false"),
            "LaunchAtStartup=" + EncodeSetting(launchAtStartup ? "true" : "false"),
            "StartMcpOnOpen=" + EncodeSetting(startMcpOnOpen ? "true" : "false"),
            "AutoCheckUpdates=" + EncodeSetting(autoCheckUpdates ? "true" : "false"),
            "GitHubRepoUrl=" + EncodeSetting(githubRepoUrl ?? string.Empty),
            "Language=" + EncodeSetting(preferredLanguage ?? "auto"),
            "LastConnectorUrl=" + EncodeSetting(lastConnectorUrl ?? string.Empty)
        };
        File.WriteAllLines(settingsFile, lines, Encoding.UTF8);
        SaveSelectedProjectPath();
        SetLaunchAtStartup(launchAtStartup);
    }

    private void SaveSelectedProjectPath()
    {
        Directory.CreateDirectory(appDataDir);
        File.WriteAllText(selectedProjectFile, selectedProjectPath ?? string.Empty, Encoding.UTF8);
    }

    private string ProjectDisplayName()
    {
        if (string.IsNullOrEmpty(selectedProjectPath)) return "Default workspace";
        return new DirectoryInfo(selectedProjectPath).Name;
    }

    private bool IsManagedProcessRunning()
    {
        try
        {
            return process != null && !process.HasExited && !stopping;
        }
        catch
        {
            return false;
        }
    }

    private bool IsPublicTunnelEnabledForLaunch()
    {
        return publicTunnelEnabled && !disableTunnelForLaunch;
    }

    private string[] BuildLauncherArgs()
    {
        var values = new List<string>();
        for (var i = 0; i < args.Length; i++)
        {
            if (IsOption(args[i], "-Workspace") || IsOption(args[i], "-Port") || IsOption(args[i], "-PublicHostname"))
            {
                i++;
                continue;
            }
            if (IsOption(args[i], "-NoTunnel") || IsOption(args[i], "-ExposeWeb") || IsOption(args[i], "-RotateOwnerToken"))
            {
                continue;
            }
            values.Add(args[i]);
        }

        values.Add("-Port");
        values.Add(port.ToString());

        var workspace = string.IsNullOrEmpty(selectedProjectPath) ? defaultWorkspace : selectedProjectPath;
        if (!string.IsNullOrWhiteSpace(workspace))
        {
            values.Add("-Workspace");
            values.Add(workspace);
        }

        if (IsPublicTunnelEnabledForLaunch())
        {
            values.Add("-ExposeWeb");
            if (!string.IsNullOrWhiteSpace(configuredPublicHost))
            {
                values.Add("-PublicHostname");
                values.Add(configuredPublicHost);
            }
        }
        return values.ToArray();
    }

    private string ConnectorUrl()
    {
        if (IsPublicTunnelEnabledForLaunch() && !string.IsNullOrEmpty(configuredPublicHost)) return "https://" + configuredPublicHost + "/mcp";
        if (!string.IsNullOrEmpty(mcpUrl)) return mcpUrl;
        if (IsPublicTunnelEnabledForLaunch()) return null;
        return "http://127.0.0.1:" + port + "/mcp";
    }

    private string DisplayConnectorUrl()
    {
        return ConnectorUrl();
    }

    private static bool IsTemporaryTunnelUrl(string url)
    {
        Uri parsed;
        return Uri.TryCreate(url, UriKind.Absolute, out parsed) &&
            parsed.Host.EndsWith(".trycloudflare.com", StringComparison.OrdinalIgnoreCase);
    }

    private string PublicHealthUrl()
    {
        var connector = ConnectorUrl();
        if (string.IsNullOrEmpty(connector)) return null;
        return Regex.Replace(connector, @"/mcp/?$", "/healthz", RegexOptions.IgnoreCase);
    }

    private string LocalHealthUrl()
    {
        return "http://127.0.0.1:" + port + "/healthz";
    }

    private string PublicControlCenterUrl()
    {
        var remote = Environment.GetEnvironmentVariable("JK_REMOTE_CONTROL_CENTER_URL"); return string.IsNullOrWhiteSpace(remote) ? LocalControlCenterUrl() : remote;
    }

    private string LocalControlCenterUrl()
    {
        return "http://127.0.0.1:" + port + "/";
    }

    private static bool IsExecutorOnlyMode()
    {
        var processValue = Environment.GetEnvironmentVariable("JK_EXECUTOR_ONLY") ?? string.Empty;
        var userValue = Environment.GetEnvironmentVariable("JK_EXECUTOR_ONLY", EnvironmentVariableTarget.User) ?? string.Empty;
        return string.Equals(processValue, "1", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(userValue, "1", StringComparison.OrdinalIgnoreCase);
    }

    private string ControlCenterUrl()
    {
        return IsExecutorOnlyMode() ? PublicControlCenterUrl() : LocalControlCenterUrl();
    }

    private string LocalApprovalsPageUrl()
    {
        return "http://127.0.0.1:" + port + "/approvals";
    }

    private string PublicApprovalsPageUrl()
    {
        return PublicControlCenterUrl().TrimEnd('/') + "/approvals";
    }

    private string ApprovalsPageUrl()
    {
        return IsExecutorOnlyMode() ? PublicApprovalsPageUrl() : LocalApprovalsPageUrl();
    }

    private string LocalApprovalsApiUrl()
    {
        return "http://127.0.0.1:" + port + "/api/jk/control/approvals";
    }

    private void StartApprovalPolling()
    {
        if (approvalPollTimer != null) return;
        approvalPollTimer = new Timer();
        approvalPollTimer.Interval = 3000;
        approvalPollTimer.Tick += delegate { PollPendingApprovals(); };
        approvalPollTimer.Start();
        PollPendingApprovals();
    }

    private void PollPendingApprovals()
    {
        if (exitRequested || !IsManagedProcessRunning())
        {
            visibleApprovalIds.Clear();
            visibleRemoteApprovalCount = 0;
            return;
        }

        if (IsExecutorOnlyMode())
        {
            if (approvalPollBusy) return;
            approvalPollBusy = true;
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    var payload = RemoteRunViewGet();
                    var count = payload == null ? 0 : payload.approvalCount;
                    if (IsDisposed || !IsHandleCreated) return;
                    BeginInvoke(new Action(delegate
                    {
                        approvalPollBusy = false;
                        if (count == visibleRemoteApprovalCount) return;
                        var increased = count > visibleRemoteApprovalCount;
                        visibleRemoteApprovalCount = count;
                        if (!increased || count <= 0) return;
                        trayIcon.BalloonTipTitle = "JK 승인 필요";
                        trayIcon.BalloonTipText = "중앙 Control Center · 승인 대기 " + count + "건" + Environment.NewLine + "클릭하여 Approvals를 여세요.";
                        trayIcon.BalloonTipIcon = ToolTipIcon.Warning;
                        trayIcon.ShowBalloonTip(8000);
                    }));
                }
                catch
                {
                    if (IsDisposed || !IsHandleCreated) return;
                    BeginInvoke(new Action(delegate { approvalPollBusy = false; }));
                }
            });
            return;
        }

        visibleRemoteApprovalCount = 0;

        try
        {
            var request = (HttpWebRequest)WebRequest.Create(LocalApprovalsApiUrl());
            request.Method = "GET";
            request.Timeout = 500;
            request.ReadWriteTimeout = 500;
            string json;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                json = reader.ReadToEnd();
            }

            var payload = new JavaScriptSerializer().Deserialize<JkApprovalsResponse>(json);
            var approvals = payload != null && payload.approvals != null ? payload.approvals : new JkApproval[0];
            var currentIds = new HashSet<string>(approvals.Where(item => item != null && !string.IsNullOrEmpty(item.id)).Select(item => item.id), StringComparer.OrdinalIgnoreCase);
            var fresh = approvals.FirstOrDefault(item => item != null && !string.IsNullOrEmpty(item.id) && !visibleApprovalIds.Contains(item.id));

            visibleApprovalIds.Clear();
            foreach (var id in currentIds) visibleApprovalIds.Add(id);
            if (fresh == null) return;

            var risk = fresh.needsNetwork && fresh.destructive ? "Network write + destructive" : fresh.destructive ? "Destructive" : "Network write";
            var command = fresh.commandPreview ?? "Approval-required command";
            if (command.Length > 120) command = command.Substring(0, 117) + "...";
            trayIcon.BalloonTipTitle = "JK 승인 필요";
            trayIcon.BalloonTipText = (fresh.projectId ?? "JK") + " · " + risk + Environment.NewLine + command + Environment.NewLine + "클릭하여 Approvals를 여세요.";
            trayIcon.BalloonTipIcon = ToolTipIcon.Warning;
            trayIcon.ShowBalloonTip(8000);
        }
        catch
        {
            // Runtime startup/restart can briefly make the local approval API unavailable.
        }
    }

    private void OpenUrl(string url)
    {
        if (string.IsNullOrEmpty(url)) return;
        Process.Start(new ProcessStartInfo
        {
            FileName = url,
            UseShellExecute = true
        });
    }

    private bool LocalRuntimeAvailable()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(LocalHealthUrl());
            request.Method = "GET";
            request.Timeout = 500;
            request.ReadWriteTimeout = 500;
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                return response.StatusCode == HttpStatusCode.OK;
            }
        }
        catch
        {
            return false;
        }
    }

    private void OpenControlCenterWhenReady()
    {
        if (dashboardOpenScheduled) return;
        dashboardOpenScheduled = true;

        if (IsExecutorOnlyMode())
        {
            OpenUrl(PublicControlCenterUrl());
            AppendLog("[JK] Opened remote Control Center in the default browser.");
            return;
        }

        var attempts = 0;
        var timer = new Timer();
        timer.Interval = 500;
        timer.Tick += delegate
        {
            attempts++;
            if (LocalRuntimeAvailable())
            {
                timer.Stop();
                timer.Dispose();
                OpenUrl(LocalControlCenterUrl());
                AppendLog("[JK] Opened local Control Center in the default browser.");
                return;
            }

            if (exitRequested || attempts >= 40)
            {
                timer.Stop();
                timer.Dispose();
                if (!exitRequested)
                {
                    AppendLog("[JK] Control Center did not become ready within 20 seconds; browser was not opened.");
                }
            }
        };
        timer.Start();
    }

    private void OpenLocalHealth()
    {
        OpenUrl(LocalHealthUrl());
    }

    private void OpenPublicHealth()
    {
        OpenUrl(PublicHealthUrl());
    }

    private void ShowLogs()
    {
        Process.Start("explorer.exe", "/select,\"" + logFile + "\"");
    }

    private void OpenGithub()
    {
        OpenUrl(githubRepoUrl);
    }

    private void CheckUpdates(bool manual)
    {
        if (updateCheckBusy || exitRequested) return;
        updateCheckBusy = true;
        if (manual) statusLabel.Text = "Checking JK updates...";
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            string message = null;
            string fallbackUrl = null;
            bool failed = false;
            try
            {
                var repo = (githubRepoUrl ?? string.Empty).TrimEnd('/');
                var match = Regex.Match(repo, @"github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)", RegexOptions.IgnoreCase);
                if (!match.Success)
                {
                    fallbackUrl = repo;
                }
                else
                {
                    var api = "https://api.github.com/repos/" + match.Groups["owner"].Value + "/" + match.Groups["repo"].Value + "/releases/latest";
                    using (var client = new WebClient())
                    {
                        client.Headers.Add("User-Agent", "JK");
                        var json = client.DownloadString(api);
                        var tagMatch = Regex.Match(json, @"""tag_name""\s*:\s*""(?<tag>[^""]+)""");
                        var latest = tagMatch.Success ? tagMatch.Groups["tag"].Value.TrimStart('v', 'V') : "latest";
                        var installed = "unknown";
                        var packageJson = Path.Combine(root, "package.json");
                        if (File.Exists(packageJson))
                        {
                            var packageText = File.ReadAllText(packageJson, Encoding.UTF8);
                            var versionMatch = Regex.Match(packageText, @"""version""\s*:\s*""(?<version>[^""]+)""");
                            if (versionMatch.Success) installed = versionMatch.Groups["version"].Value;
                        }
                        message = latest == installed
                            ? "JK is up to date (" + installed + ")."
                            : "Update available: " + latest + ". Installed: " + installed + ".";
                    }
                }
            }
            catch
            {
                failed = true;
                fallbackUrl = (githubRepoUrl ?? string.Empty).TrimEnd('/') + "/releases";
            }

            if (IsDisposed || !IsHandleCreated)
            {
                updateCheckBusy = false;
                return;
            }
            BeginInvoke(new Action(delegate
            {
                updateCheckBusy = false;
                if (failed)
                {
                    statusLabel.Text = "Update check failed.";
                    if (manual && MessageBox.Show(this, "Could not check releases automatically. Open releases page?", "JK", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                    {
                        OpenUrl(fallbackUrl);
                    }
                    return;
                }
                if (!string.IsNullOrWhiteSpace(fallbackUrl) && string.IsNullOrWhiteSpace(message))
                {
                    if (manual) OpenUrl(fallbackUrl);
                    return;
                }
                if (manual) MessageBox.Show(this, message ?? "Update check complete.", "JK", MessageBoxButtons.OK, MessageBoxIcon.Information);
                else statusLabel.Text = message ?? "Update check complete.";
            }));
        });
    }

    private bool MigrateLegacyExecutorStartupIntent()
    {
        try
        {
            var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            if (string.IsNullOrWhiteSpace(startup)) return false;
            var legacyLauncher = Path.Combine(startup, "JK Executor.cmd");
            if (!File.Exists(legacyLauncher)) return false;
            var legacyText = File.ReadAllText(legacyLauncher, Encoding.UTF8);
            if (legacyText.IndexOf("executor-supervisor.js", StringComparison.OrdinalIgnoreCase) < 0) return false;
            File.Delete(legacyLauncher);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private string ResolveStartupExecutablePath()
    {
        var executablePath = Path.GetFullPath(Application.ExecutablePath);
        var runtimeDir = Directory.GetParent(executablePath);
        if (runtimeDir == null) return executablePath;

        var name = runtimeDir.Name;
        var isStagingRuntime =
            name.Equals("JK-next", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("JK-prev", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("JK-stage", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("JK-runtime-candidate", StringComparison.OrdinalIgnoreCase) ||
            name.StartsWith("JK-stage-", StringComparison.OrdinalIgnoreCase);
        if (!isStagingRuntime || runtimeDir.Parent == null) return executablePath;

        // Staging/rollback packages are never valid persistent launch targets.
        // Point startup at the canonical sibling even before the atomic swap has
        // created it; the reload script promotes the candidate into that path.
        return Path.Combine(runtimeDir.Parent.FullName, "JK", "JK.exe");
    }

    private void SetLaunchAtStartup(bool enabled)
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            {
                if (key == null) return;
                if (enabled)
                {
                    key.SetValue("JK", "\"" + ResolveStartupExecutablePath() + "\"");
                }
                else
                {
                    key.DeleteValue("JK", false);
                }
            }
        }
        catch
        {
            // Startup registration is best-effort.
        }
    }

    private bool HasProjectMarker(string path)
    {
        var markers = new[] { ".git", "package.json", "pubspec.yaml", "go.mod", "Cargo.toml", "requirements.txt", ".jk", ".chatgpt2codex" };
        return markers.Any(marker => Directory.Exists(Path.Combine(path, marker)) || File.Exists(Path.Combine(path, marker)));
    }

    private void SelectProjectFolder()
    {
        using (var dialog = new FolderBrowserDialog())
        {
            dialog.Description = "Select Project Folder";
            dialog.ShowNewFolderButton = true;
            var initial = selectedProjectPath ?? defaultWorkspace;
            if (Directory.Exists(initial)) dialog.SelectedPath = initial;

            ShowFromTray();
            if (dialog.ShowDialog(this) != DialogResult.OK) return;

            var path = Path.GetFullPath(dialog.SelectedPath);
            Directory.CreateDirectory(path);

            var shouldRestart = IsManagedProcessRunning();
            selectedProjectPath = path;
            SaveSelectedProjectPath();
            AppendLog("[JK] Selected project folder: " + selectedProjectPath);
            RefreshTrayState();

            if (shouldRestart)
            {
                RestartServer();
            }
        }
    }

    private static Label NewLabel(string text, int x, int y, int width)
    {
        var label = new Label();
        label.Text = text;
        label.SetBounds(x, y, width, 22);
        return label;
    }

    private static Button NewButton(string text, int x, int y, int width)
    {
        var button = new Button();
        button.Text = text;
        button.SetBounds(x, y, width, 32);
        StyleActionButton(button, false);
        return button;
    }

    private static void StyleActionButton(Button button, bool primary)
    {
        // Custom-painted rounded button. The stock flat button is only used
        // for input handling; Paint draws the whole surface.
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = primary ? JkAccentHover : JkSurfaceAlt;
        button.FlatAppearance.MouseDownBackColor = primary ? JkAccentHover : JkSurfaceAlt;
        button.BackColor = primary ? JkAccent : JkSurface;
        button.ForeColor = primary ? JkAccentText : JkText;
        button.Font = UiSemibold(9f);
        button.Cursor = Cursors.Hand;
        var hover = false;
        var down = false;
        button.MouseEnter += delegate { hover = true; button.Invalidate(); };
        button.MouseLeave += delegate { hover = false; down = false; button.Invalidate(); };
        button.MouseDown += delegate { down = true; button.Invalidate(); };
        button.MouseUp += delegate { down = false; button.Invalidate(); };
        button.EnabledChanged += delegate { button.Invalidate(); };
        button.TextChanged += delegate { button.Invalidate(); };
        button.Paint += delegate(object sender, PaintEventArgs e) { PaintActionButton(button, e.Graphics, primary, hover, down); };
    }

    private static void PaintActionButton(Button button, System.Drawing.Graphics g, bool primary, bool hover, bool down)
    {
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.Clear(EffectiveBackColor(button.Parent));
        System.Drawing.Color fill;
        System.Drawing.Color border;
        System.Drawing.Color text;
        if (!button.Enabled)
        {
            fill = primary ? System.Drawing.Color.FromArgb(232, 222, 204) : JkSurfaceAlt;
            border = primary ? fill : JkBorder;
            text = primary ? System.Drawing.Color.FromArgb(146, 128, 98) : System.Drawing.Color.FromArgb(160, 166, 176);
        }
        else if (primary)
        {
            fill = down ? System.Drawing.Color.FromArgb(186, 150, 92) : hover ? JkAccentHover : JkAccent;
            border = fill;
            text = JkAccentText;
        }
        else
        {
            fill = down ? System.Drawing.Color.FromArgb(233, 236, 241) : hover ? JkSurfaceAlt : JkSurface;
            border = hover ? System.Drawing.Color.FromArgb(206, 211, 219) : JkBorder;
            text = JkText;
        }
        var rect = new System.Drawing.Rectangle(0, 0, button.Width - 1, button.Height - 1);
        using (var path = RoundedRect(rect, 8))
        using (var brush = new System.Drawing.SolidBrush(fill))
        using (var pen = new System.Drawing.Pen(border))
        {
            g.FillPath(brush, path);
            g.DrawPath(pen, path);
        }
        TextRenderer.DrawText(g, button.Text, button.Font, button.ClientRectangle, text,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
    }

    private static System.Drawing.Color EffectiveBackColor(Control control)
    {
        while (control != null)
        {
            if (control.BackColor.A == 255) return control.BackColor;
            control = control.Parent;
        }
        return JkCanvas;
    }

    internal static System.Drawing.Drawing2D.GraphicsPath RoundedRect(System.Drawing.Rectangle rect, int radius)
    {
        var path = new System.Drawing.Drawing2D.GraphicsPath();
        var d = Math.Max(1, Math.Min(radius * 2, Math.Min(rect.Width, rect.Height)));
        path.AddArc(rect.X, rect.Y, d, d, 180, 90);
        path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static readonly string UiFamily = PickFont("Segoe UI");
    private static readonly string MonoFamily = PickFont("Cascadia Mono", "Consolas");
    private static readonly string IconFamily = PickFont("Segoe Fluent Icons", "Segoe MDL2 Assets", "");

    private static string PickFont(params string[] candidates)
    {
        try
        {
            using (var installed = new System.Drawing.Text.InstalledFontCollection())
            {
                var names = new HashSet<string>(installed.Families.Select(family => family.Name), StringComparer.OrdinalIgnoreCase);
                foreach (var candidate in candidates)
                {
                    if (string.IsNullOrEmpty(candidate) || names.Contains(candidate)) return candidate;
                }
            }
        }
        catch
        {
            // Font enumeration is best-effort; fall back to the last candidate.
        }
        return candidates[candidates.Length - 1];
    }

    private static System.Drawing.Font UiFont(float size)
    {
        return new System.Drawing.Font(UiFamily, size, System.Drawing.FontStyle.Regular);
    }

    private static System.Drawing.Font UiSemibold(float size)
    {
        try { return new System.Drawing.Font("Segoe UI Semibold", size, System.Drawing.FontStyle.Regular); }
        catch { return new System.Drawing.Font(UiFamily, size, System.Drawing.FontStyle.Bold); }
    }

    private static System.Drawing.Font MonoFont(float size)
    {
        return new System.Drawing.Font(MonoFamily, size, System.Drawing.FontStyle.Regular);
    }

    private static JkCard NewCard(System.Drawing.Color fill)
    {
        var card = new JkCard();
        card.FillColor = fill;
        card.Dock = DockStyle.Fill;
        card.Padding = new Padding(20, 16, 20, 14);
        card.Margin = new Padding(0, 0, 0, 14);
        return card;
    }

    private static Label NewCaption(string text, System.Drawing.Color background)
    {
        var label = new Label();
        label.Text = text.ToUpperInvariant();
        label.Dock = DockStyle.Fill;
        label.BackColor = background;
        label.ForeColor = JkMuted;
        label.Font = UiSemibold(8.25f);
        label.Padding = new Padding(1, 4, 0, 0);
        return label;
    }

    /// <summary>Wraps a borderless TextBox in a rounded, filled input field.</summary>
    private static JkCard NewField(TextBox box)
    {
        var field = new JkCard();
        field.FillColor = JkSurfaceAlt;
        field.BorderColor = JkBorder;
        field.Radius = 8;
        field.Dock = DockStyle.Fill;
        field.Margin = new Padding(0, 1, 0, 1);
        field.Padding = new Padding(12, 10, 12, 4);
        field.Controls.Add(box);
        field.Click += delegate { box.Focus(); box.SelectAll(); };
        return field;
    }

    /// <summary>Static sample state for --ui-preview (design QA screenshots). Starts nothing.</summary>
    private void ShowUiPreviewState()
    {
        statusLabel.Text = "MCP endpoint available; waiting for ChatGPT connection";
        UpdateStatusPill(true);
        urlBox.Text = "https://sample-quiet-river.trycloudflare.com/mcp";
        copyButton.Enabled = true;
        ownerTokenBox.Text = L("ownerTokenConfigured");
        copyOwnerTokenButton.Enabled = false;
        stopButton.Text = L("stopMCP");
        dashboardProjectValue.Text = "my-app";
        dashboardRoleValue.Text = "Default";
        dashboardModeValue.Text = "Full write";
        dashboardSkillsValue.Text = "—";
        logBox.Text = string.Join("\r\n", new[]
        {
            "[JK] runtime mode: portable",
            "[JK] workspace: C:\\Users\\me\\workspace",
            "[JK] 1/3 starting public tunnel...",
            "[JK] 2/3 starting local HTTP/OAuth MCP server...",
            "jk serve --http: listening on http://127.0.0.1:7979/mcp",
            "[JK] connector URL: https://sample-quiet-river.trycloudflare.com/mcp",
            "[JK] 3/3 public health OK"
        });
    }

    private void UpdateConnectorHint()
    {
        if (connectorHint == null) return;
        var url = urlBox == null ? string.Empty : (urlBox.Text ?? string.Empty);
        if (url.IndexOf("trycloudflare.com", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            connectorHint.Text = "\u26A0  " + L("connectorHintTemporary");
            connectorHint.ForeColor = JkWarning;
        }
        else
        {
            connectorHint.Text = L("connectorHintDefault");
            connectorHint.ForeColor = JkMuted;
        }
    }

    private void UpdateStatusPill(bool running)
    {
        if (statusPill == null) return;
        var pill = (JkPill)statusPill;
        pill.Active = running;
        pill.Text = running ? L("statusRunning") : L("statusStopped");
    }

    private void SetActiveNav(Button active)
    {
        foreach (var button in navButtons)
        {
            var nav = button as JkNavButton;
            if (nav != null) nav.Active = object.ReferenceEquals(button, active);
        }

    }

    private static void SetNavGlyph(Button button, string glyph)
    {
        var nav = button as JkNavButton;
        if (nav != null && !string.IsNullOrEmpty(IconFamily)) nav.Glyph = glyph;
    }

    [System.Runtime.InteropServices.DllImport("uxtheme.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int SetWindowTheme(IntPtr hwnd, string subAppName, string subIdList);

    /// <summary>Modern Explorer list/scrollbar styling for light surfaces.</summary>
    private static void UseExplorerTheme(IntPtr handle)
    {
        try { SetWindowTheme(handle, "Explorer", null); }
        catch { /* keep the default theme */ }
    }

    /// <summary>Dark native scrollbars for controls on dark surfaces (Windows 10 1809+).</summary>
    private static void UseDarkScrollbars(IntPtr handle)
    {
        try { SetWindowTheme(handle, "DarkMode_Explorer", null); }
        catch { /* older Windows: keep the default theme */ }
    }

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>Dark title bar + rounded corners on Windows 10/11; no-op elsewhere.</summary>
    private static void ApplyWindowChrome(IntPtr handle)
    {
        try
        {
            var dark = 1;
            DwmSetWindowAttribute(handle, 20, ref dark, 4);
            var round = 2;
            DwmSetWindowAttribute(handle, 33, ref round, 4);
            var caption = System.Drawing.ColorTranslator.ToWin32(JkSidebar);
            DwmSetWindowAttribute(handle, 35, ref caption, 4);
            var captionText = System.Drawing.ColorTranslator.ToWin32(System.Drawing.Color.FromArgb(229, 231, 235));
            DwmSetWindowAttribute(handle, 36, ref captionText, 4);
        }
        catch
        {
            // dwmapi missing or attribute unsupported: keep the default frame.
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyWindowChrome(Handle);
    }

    private static Label NewSummaryTitle(string text)
    {
        var label = new Label();
        label.Text = text;
        label.Dock = DockStyle.Fill;
        label.Padding = new Padding(0, 0, 0, 0);
        label.Font = UiSemibold(8f);
        label.ForeColor = JkMuted;
        label.BackColor = JkSurface;
        return label;
    }

    private static Label NewSummaryValue(string text)
    {
        var label = new Label();
        label.Text = text;
        label.Dock = DockStyle.Fill;
        label.Padding = new Padding(0, 4, 0, 0);
        label.Font = UiSemibold(11.5f);
        label.ForeColor = JkText;
        label.BackColor = JkSurface;
        label.AutoEllipsis = true;
        return label;
    }

    private static Button NewNavigationButton(string text, int top)
    {
        var button = new JkNavButton();
        button.Text = text;
        button.SetBounds(12, top, 196, 38);
        button.BackColor = JkSidebar;
        button.Font = UiSemibold(9.5f);
        return button;
    }

    /// <summary>Rounded panel; corners are painted with the parent's colour.</summary>
    internal sealed class JkCard : Panel
    {
        private System.Drawing.Color fillColor = JkSurface;
        public System.Drawing.Color BorderColor = JkBorder;
        public int Radius = 12;

        /// <summary>Card fill; also the BackColor children inherit.</summary>
        public System.Drawing.Color FillColor
        {
            get { return fillColor; }
            set { fillColor = value; BackColor = value; Invalidate(); }
        }

        public JkCard()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            BackColor = fillColor;
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(EffectiveBackColor(Parent));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var rect = new System.Drawing.Rectangle(0, 0, Width - 1, Height - 1);
            using (var path = RoundedRect(rect, Radius))
            using (var brush = new System.Drawing.SolidBrush(FillColor))
            using (var pen = new System.Drawing.Pen(BorderColor))
            {
                g.FillPath(brush, path);
                g.DrawPath(pen, path);
            }
        }

    }

    /// <summary>Status pill: green dot + text when active, grey when stopped.</summary>
    internal sealed class JkPill : Label
    {
        private bool active;

        public bool Active
        {
            get { return active; }
            set { active = value; Invalidate(); }
        }

        public JkPill()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            AutoSize = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(EffectiveBackColor(Parent));
            var fill = active ? System.Drawing.Color.FromArgb(220, 252, 231) : System.Drawing.Color.FromArgb(236, 238, 242);
            var dot = active ? JkSuccess : System.Drawing.Color.FromArgb(156, 163, 175);
            var ink = active ? System.Drawing.Color.FromArgb(21, 128, 61) : JkMuted;
            var textWidth = TextRenderer.MeasureText(Text ?? string.Empty, Font).Width;
            var width = Math.Min(Width - 1, textWidth + 38);
            var rect = new System.Drawing.Rectangle(Width - 1 - width, 0, width, Height - 1);
            using (var path = RoundedRect(rect, rect.Height / 2))
            using (var brush = new System.Drawing.SolidBrush(fill))
            {
                g.FillPath(brush, path);
            }
            using (var brush = new System.Drawing.SolidBrush(dot))
            {
                g.FillEllipse(brush, rect.X + 13, rect.Y + rect.Height / 2 - 4, 8, 8);
            }
            var textRect = new System.Drawing.Rectangle(rect.X + 27, rect.Y, rect.Width - 30, rect.Height);
            TextRenderer.DrawText(g, Text, Font, textRect, ink, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.SingleLine);
        }
    }

    /// <summary>Sidebar item with icon glyph, hover fill, and an accent bar when active.</summary>
    internal sealed class JkNavButton : Button
    {
        private bool active;
        private bool hover;
        public string Glyph;

        public bool Active
        {
            get { return active; }
            set { active = value; Invalidate(); }
        }

        public JkNavButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Cursor = Cursors.Hand;
            TabStop = true;
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hover = true; Invalidate(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hover = false; Invalidate(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(EffectiveBackColor(Parent));
            if (active || hover)
            {
                using (var path = RoundedRect(new System.Drawing.Rectangle(0, 0, Width - 1, Height - 1), 8))
                using (var brush = new System.Drawing.SolidBrush(active ? JkSidebarActive : JkSidebarHover))
                {
                    g.FillPath(brush, path);
                }
            }
            if (active)
            {
                using (var path = RoundedRect(new System.Drawing.Rectangle(0, 10, 3, Height - 21), 1))
                using (var brush = new System.Drawing.SolidBrush(JkAccent))
                {
                    g.FillPath(brush, path);
                }
            }
            var ink = active ? System.Drawing.Color.White : hover ? System.Drawing.Color.FromArgb(226, 230, 236) : System.Drawing.Color.FromArgb(160, 168, 181);
            var textLeft = 16;
            if (!string.IsNullOrEmpty(Glyph) && !string.IsNullOrEmpty(IconFamily))
            {
                using (var iconFont = new System.Drawing.Font(IconFamily, 11f, System.Drawing.FontStyle.Regular))
                {
                    var glyphInk = active ? JkAccent : ink;
                    TextRenderer.DrawText(g, Glyph, iconFont, new System.Drawing.Rectangle(14, 0, 22, Height), glyphInk,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPrefix);
                }
                textLeft = 46;
            }
            TextRenderer.DrawText(g, Text, Font, new System.Drawing.Rectangle(textLeft, 0, Width - textLeft - 8, Height), ink,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
        }
    }

    private System.Drawing.Bitmap BuildSidebarBrandImage()
    {
        return BuildSidebarBrandImage(Icon ?? System.Drawing.SystemIcons.Application);
    }

    private static System.Drawing.Bitmap BuildSidebarBrandImage(System.Drawing.Icon sourceIcon)
    {
        using (var source = sourceIcon.ToBitmap())
        {
            var result = new System.Drawing.Bitmap(source.Width, source.Height);
            for (var y = 0; y < source.Height; y++)
            {
                for (var x = 0; x < source.Width; x++)
                {
                    var pixel = source.GetPixel(x, y);
                    if (pixel.A == 0) continue;
                    result.SetPixel(x, y, System.Drawing.Color.FromArgb(pixel.A, 255, 255, 255));
                }
            }
            return result;
        }
    }

    private static string PermissionLabel(string preset)
    {
        switch (preset ?? string.Empty)
        {
            case "inherit": return "Project Default";
            case "read-only": return "Read Only";
            case "tests-only": return "Tests Only";
            case "full-write": return "Full Write";
            case "image-only": return "Image Only";
            case "control": return "Control";
            default: return string.IsNullOrWhiteSpace(preset) ? "No active lease" : preset;
        }
    }

    private string RoleApiBase()
    {
        return "http://127.0.0.1:" + port + "/api/jk";
    }

    private T RoleApiRequest<T>(string method, string path, object body)
    {
        var serializer = new JavaScriptSerializer();
        using (var client = new WebClient())
        {
            client.Encoding = Encoding.UTF8;
            client.Headers[HttpRequestHeader.ContentType] = "application/json; charset=utf-8";
            var uri = RoleApiBase() + path;
            string json;
            if (string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase))
            {
                json = client.DownloadString(uri);
            }
            else
            {
                json = client.UploadString(uri, method, serializer.Serialize(body ?? new object()));
            }
            return serializer.Deserialize<T>(json);
        }
    }

    private T RoleApiGet<T>(string path)
    {
        return RoleApiRequest<T>("GET", path, null);
    }

    private bool RoleApiAvailable()
    {
        try
        {
            var response = RoleApiGet<JkProjectsResponse>("/projects");
            return response != null && response.ok;
        }
        catch
        {
            return false;
        }
    }

    private void ShowRoleApiUnavailable()
    {
        MessageBox.Show(
            this,
            "Roles are managed by the local JK runtime. Start MCP first, then open this page again.",
            "JK Roles",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private void RefreshRoleData(string preferredProjectId)
    {
        var projectsResponse = RoleApiGet<JkProjectsResponse>("/projects");
        cachedProjects = projectsResponse != null && projectsResponse.projects != null
            ? projectsResponse.projects
            : new JkProject[0];

        var resolvedProjectId = preferredProjectId;
        if (string.IsNullOrWhiteSpace(resolvedProjectId) && !string.IsNullOrWhiteSpace(consoleProjectId))
        {
            resolvedProjectId = consoleProjectId;
        }
        if (string.IsNullOrWhiteSpace(resolvedProjectId) && !string.IsNullOrWhiteSpace(projectsResponse.activeProjectId))
        {
            resolvedProjectId = projectsResponse.activeProjectId;
        }
        if (string.IsNullOrWhiteSpace(resolvedProjectId) && !string.IsNullOrWhiteSpace(selectedProjectPath))
        {
            var normalizedSelected = Path.GetFullPath(selectedProjectPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var byRoot = cachedProjects.FirstOrDefault(project =>
            {
                if (project == null || string.IsNullOrWhiteSpace(project.root)) return false;
                try
                {
                    return string.Equals(
                        Path.GetFullPath(project.root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                        normalizedSelected,
                        StringComparison.OrdinalIgnoreCase);
                }
                catch { return false; }
            });
            if (byRoot != null) resolvedProjectId = byRoot.projectId;
        }
        if (string.IsNullOrWhiteSpace(resolvedProjectId) && cachedProjects.Length > 0)
        {
            resolvedProjectId = cachedProjects[0].projectId;
        }

        consoleProjectId = resolvedProjectId;
        var rolesPath = "/roles";
        if (!string.IsNullOrWhiteSpace(consoleProjectId))
        {
            rolesPath += "?projectId=" + Uri.EscapeDataString(consoleProjectId);
        }
        var rolesResponse = RoleApiGet<JkRolesResponse>(rolesPath);
        cachedRoles = rolesResponse != null && rolesResponse.roles != null ? rolesResponse.roles : new JkRole[0];
        cachedWorkflowPresets = rolesResponse != null && rolesResponse.workflowPresets != null ? rolesResponse.workflowPresets : new JkWorkflowPreset[0];
        cachedRoleContext = rolesResponse == null ? null : rolesResponse.activeRoleContext;
    }

    private void ShowConsolePage(Control page)
    {
        runsPageVisible = object.ReferenceEquals(page, runsPanel);
        var existing = contentHost.Controls.Cast<Control>().ToArray();
        foreach (var control in existing)
        {
            if (object.ReferenceEquals(control, page)) continue;
            if (object.ReferenceEquals(control, dashboardPanel) || object.ReferenceEquals(control, runsPanel))
            {
                control.Visible = false;
                continue;
            }
            contentHost.Controls.Remove(control);
            control.Dispose();
        }
        page.Dock = DockStyle.Fill;
        if (!contentHost.Controls.Contains(page)) contentHost.Controls.Add(page);
        page.Visible = true;
        page.BringToFront();
    }

    private void RefreshDashboardRoleSummary()
    {
        dashboardProjectValue.Text = !string.IsNullOrWhiteSpace(selectedProjectPath)
            ? Path.GetFileName(selectedProjectPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
            : "—";
        if (dashboardRoleRefreshBusy || exitRequested) return;
        dashboardRoleRefreshBusy = true;
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            JkRoleContext context = null;
            try
            {
                if (RoleApiAvailable())
                {
                    RefreshRoleData(consoleProjectId);
                    context = cachedRoleContext;
                }
            }
            catch
            {
                // Dashboard remains usable even if the local role API is temporarily unavailable.
            }

            if (IsDisposed || !IsHandleCreated)
            {
                dashboardRoleRefreshBusy = false;
                return;
            }
            BeginInvoke(new Action(delegate
            {
                dashboardRoleRefreshBusy = false;
                if (context == null) return;
                dashboardProjectValue.Text = string.IsNullOrWhiteSpace(context.projectName) ? "—" : context.projectName;
                dashboardRoleValue.Text = context.role == null ? "Default" : context.role.name;
                dashboardModeValue.Text = PermissionLabel(context.effectivePermission);
                dashboardSkillsValue.Text = context.role != null && context.role.skills != null && context.role.skills.Length > 0
                    ? string.Join(" · ", context.role.skills)
                    : "—";
            }));
        });
    }

    private void ShowDashboardPage()
    {
        ShowConsolePage(dashboardPanel);
        RefreshDashboardRoleSummary();
    }

    private Panel BuildRunsPanel()
    {
        var panel = new Panel();
        panel.BackColor = JkCanvas;

        var layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Fill;
        layout.Padding = new Padding(28, 24, 28, 24);
        layout.ColumnCount = 1;
        layout.RowCount = 3;
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 140));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.BackColor = JkCanvas;
        panel.Controls.Add(layout);

        var header = new TableLayoutPanel();
        header.Dock = DockStyle.Fill;
        header.ColumnCount = 2;
        header.RowCount = 1;
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 75));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        var headerCopy = new Panel();
        headerCopy.Dock = DockStyle.Fill;
        var title = NewLabel("Runs", 0, 0, 520);
        title.Font = UiSemibold(17f);
        title.ForeColor = JkText;
        title.Height = 36;
        var description = NewLabel("JK가 지금 무엇을 실행하고 왜 기다리는지 앱 안에서 바로 확인합니다.", 1, 38, 620);
        description.ForeColor = JkMuted;
        description.Font = UiFont(9.75f);
        description.Height = 26;
        headerCopy.Controls.Add(title);
        headerCopy.Controls.Add(description);
        runConnectionValue = new Label();
        runConnectionValue.Dock = DockStyle.Fill;
        runConnectionValue.Text = "Runtime 확인 중";
        runConnectionValue.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
        runConnectionValue.ForeColor = JkMuted;
        header.Controls.Add(headerCopy, 0, 0);
        header.Controls.Add(runConnectionValue, 1, 0);
        layout.Controls.Add(header, 0, 0);

        var summaryCard = NewCard(JkSurface);
        var summary = new TableLayoutPanel();
        summary.Dock = DockStyle.Fill;
        summary.BackColor = JkSurface;
        summary.Padding = new Padding(0);
        summary.ColumnCount = 2;
        summary.RowCount = 3;
        summary.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62));
        summary.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
        summary.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        summary.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        summary.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        runGoalValue = new Label();
        runGoalValue.Dock = DockStyle.Fill;
        runGoalValue.Text = "활성 실행 없음";
        runGoalValue.Font = UiSemibold(13f);
        runGoalValue.ForeColor = JkText;
        runGoalValue.AutoEllipsis = true;
        runTaskValue = new Label();
        runTaskValue.Dock = DockStyle.Fill;
        runTaskValue.Text = "새 @jk 작업을 시작하면 여기에 표시됩니다.";
        runTaskValue.ForeColor = JkMuted;
        runTaskValue.AutoEllipsis = true;
        runMetaValue = new Label();
        runMetaValue.Dock = DockStyle.Fill;
        runMetaValue.Text = "IDLE";
        runMetaValue.ForeColor = JkMuted;
        runMetaValue.Font = UiSemibold(8.5f);
        runWaitValue = new Label();
        runWaitValue.Dock = DockStyle.Fill;
        runWaitValue.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
        runWaitValue.Text = "대기 중";
        runWaitValue.ForeColor = System.Drawing.Color.FromArgb(120, 90, 20);
        summary.Controls.Add(runGoalValue, 0, 0);
        summary.SetColumnSpan(runGoalValue, 2);
        summary.Controls.Add(runTaskValue, 0, 1);
        summary.SetColumnSpan(runTaskValue, 2);
        summary.Controls.Add(runMetaValue, 0, 2);
        summary.Controls.Add(runWaitValue, 1, 2);
        summaryCard.Controls.Add(summary);
        layout.Controls.Add(summaryCard, 0, 1);

        var split = new SplitContainer();
        split.Dock = DockStyle.Fill;
        split.Orientation = Orientation.Vertical;
        split.BackColor = JkCanvas;
        split.SplitterWidth = 14;
        split.Panel1.BackColor = JkCanvas;
        split.Panel2.BackColor = JkCanvas;
        split.SizeChanged += delegate
        {
            const int panel1Min = 280;
            const int panel2Min = 220;
            if (split.Width <= panel1Min + panel2Min + split.SplitterWidth) return;
            if (split.Panel1MinSize != panel1Min) split.Panel1MinSize = panel1Min;
            if (split.Panel2MinSize != panel2Min) split.Panel2MinSize = panel2Min;
            var target = (int)(split.Width * 0.72);
            var maximum = split.Width - panel2Min - split.SplitterWidth;
            split.SplitterDistance = Math.Max(panel1Min, Math.Min(maximum, target));
        };

        var lanesPanel = NewCard(JkSurface);
        lanesPanel.Margin = new Padding(0);
        lanesPanel.Padding = new Padding(18, 12, 18, 14);
        var lanesTitle = new Label();
        lanesTitle.Text = "작업 / lane DAG";
        lanesTitle.Dock = DockStyle.Top;
        lanesTitle.Height = 30;
        lanesTitle.Padding = new Padding(0, 4, 0, 0);
        lanesTitle.Font = UiSemibold(10.5f);
        lanesTitle.BackColor = JkSurface;
        lanesTitle.ForeColor = JkText;
        runDagValue = new Label();
        runDagValue.Text = "병렬 작업이 시작되면 의존관계를 표시합니다.";
        runDagValue.Dock = DockStyle.Top;
        runDagValue.Height = 40;
        runDagValue.Padding = new Padding(0, 4, 0, 4);
        runDagValue.BackColor = JkSurface;
        runDagValue.ForeColor = JkMuted;
        runDagValue.AutoEllipsis = true;
        runLaneFlow = new Panel();
        runLaneFlow.Dock = DockStyle.Fill;
        runLaneFlow.AutoScroll = true;
        runLaneFlow.BackColor = JkSurface;
        runLaneFlow.SizeChanged += delegate { LayoutRunDag(); };
        runLaneFlow.Scroll += delegate { runLaneFlow.Invalidate(); };
        runLaneFlow.Paint += delegate(object sender, PaintEventArgs e) { DrawRunDagEdges(e.Graphics); };
        lanesPanel.Controls.Add(runLaneFlow);
        lanesPanel.Controls.Add(runDagValue);
        lanesPanel.Controls.Add(lanesTitle);
        split.Panel1.Controls.Add(lanesPanel);

        var eventsPanel = NewCard(JkSurface);
        eventsPanel.Margin = new Padding(0);
        eventsPanel.Padding = new Padding(14, 12, 10, 14);
        var eventsTitle = new Label();
        eventsTitle.Text = "최근 이벤트";
        eventsTitle.Dock = DockStyle.Top;
        eventsTitle.Height = 30;
        eventsTitle.Padding = new Padding(4, 4, 0, 0);
        eventsTitle.Font = UiSemibold(10.5f);
        eventsTitle.BackColor = JkSurface;
        eventsTitle.ForeColor = JkText;
        runEventList = new ListView();
        runEventList.Dock = DockStyle.Fill;
        runEventList.View = View.Details;
        runEventList.FullRowSelect = true;
        runEventList.HeaderStyle = ColumnHeaderStyle.Nonclickable;
        runEventList.BorderStyle = BorderStyle.None;
        runEventList.BackColor = JkSurface;
        runEventList.ForeColor = JkText;
        runEventList.Font = UiFont(9f);
        runEventList.HandleCreated += delegate { UseExplorerTheme(runEventList.Handle); };
        runEventList.Columns.Add("Time", 68);
        runEventList.Columns.Add("Event", 120);
        runEventList.Columns.Add("Detail", 220);
        eventsPanel.Controls.Add(runEventList);
        eventsPanel.Controls.Add(eventsTitle);
        split.Panel2.Controls.Add(eventsPanel);
        layout.Controls.Add(split, 0, 2);

        return panel;
    }

    private void ShowRunsPage()
    {
        ShowConsolePage(runsPanel);
        RefreshRunsPage(true);
    }

    private void StartRunPolling()
    {
        if (runPollTimer != null) return;
        runPollTimer = new Timer();
        runPollTimer.Interval = 1500;
        runPollTimer.Tick += delegate { if (runsPageVisible) RefreshRunsPage(false); };
        runPollTimer.Start();
    }

    private T ControlApiGet<T>(string path)
    {
        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/jk" + path);
        request.Method = "GET";
        request.Timeout = 700;
        request.ReadWriteTimeout = 700;
        request.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var stream = response.GetResponseStream())
        using (var reader = new StreamReader(stream, Encoding.UTF8))
        {
            return new JavaScriptSerializer().Deserialize<T>(reader.ReadToEnd());
        }
    }

    private static string ExecutorSetting(string name)
    {
        var value = Environment.GetEnvironmentVariable(name) ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        return (Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User) ?? string.Empty).Trim();
    }

    private static string ExecutorHubBaseUrl()
    {
        var hub = ExecutorSetting("JK_HUB_URL").TrimEnd('/');
        if (hub.EndsWith("/mcp", StringComparison.OrdinalIgnoreCase)) hub = hub.Substring(0, hub.Length - 4).TrimEnd('/');
        return hub;
    }

    private static string ExecutorToken()
    {
        var tokenFile = ExecutorSetting("JK_EXECUTOR_TOKEN_FILE");
        if (string.IsNullOrWhiteSpace(tokenFile) || !File.Exists(tokenFile)) return string.Empty;
        try { return File.ReadAllText(tokenFile, Encoding.ASCII).Trim(); }
        catch { return string.Empty; }
    }

    private JkExecutorRunViewResponse RemoteRunViewGet()
    {
        var hub = ExecutorHubBaseUrl();
        var token = ExecutorToken();
        var executorId = ExecutorSetting("JK_EXECUTOR_ID");
        if (string.IsNullOrWhiteSpace(executorId)) executorId = "windows-main";
        if (string.IsNullOrWhiteSpace(hub) || string.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("JK hub credentials are unavailable.");
        var url = hub + "/api/executors/" + Uri.EscapeDataString(executorId) + "/run-view";
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = "GET";
        request.Timeout = 2500;
        request.ReadWriteTimeout = 2500;
        request.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
        request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var stream = response.GetResponseStream())
        using (var reader = new StreamReader(stream, Encoding.UTF8))
        {
            return new JavaScriptSerializer().Deserialize<JkExecutorRunViewResponse>(reader.ReadToEnd());
        }
    }

    private void RefreshRunsPage(bool userInitiated)
    {
        if (runRefreshBusy || exitRequested || !runsPageVisible) return;
        runRefreshBusy = true;
        runConnectionValue.Text = "Runtime 동기화 중";
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                JkExecution execution;
                int approvalCount;
                JkAuditEvent[] logs;
                if (IsExecutorOnlyMode())
                {
                    var remotePayload = RemoteRunViewGet();
                    execution = remotePayload == null ? null : remotePayload.execution;
                    approvalCount = remotePayload == null ? 0 : remotePayload.approvalCount;
                    logs = remotePayload != null && remotePayload.logs != null ? remotePayload.logs : new JkAuditEvent[0];
                }
                else
                {
                    var executionPayload = ControlApiGet<JkExecutionResponse>("/control/execution");
                    var approvalsPayload = ControlApiGet<JkApprovalsResponse>("/control/approvals");
                    var logsPayload = ControlApiGet<JkLogsResponse>("/control/logs?limit=24");
                    execution = executionPayload == null ? null : executionPayload.execution;
                    var approvals = approvalsPayload != null && approvalsPayload.approvals != null ? approvalsPayload.approvals : new JkApproval[0];
                    approvalCount = approvals.Length;
                    logs = logsPayload != null && logsPayload.logs != null ? logsPayload.logs : new JkAuditEvent[0];
                }
                if (IsDisposed || !IsHandleCreated) return;
                BeginInvoke(new Action(delegate
                {
                    runRefreshBusy = false;
                    if (!runsPageVisible) return;
                    ApplyRunSnapshot(execution, approvalCount, logs);
                    runConnectionValue.Text = IsExecutorOnlyMode() ? "● Hub live · 1.5s" : "● Live · 1.5s";
                    runConnectionValue.ForeColor = System.Drawing.Color.FromArgb(48, 126, 75);
                }));
            }
            catch (Exception ex)
            {
                if (IsDisposed || !IsHandleCreated) return;
                BeginInvoke(new Action(delegate
                {
                    runRefreshBusy = false;
                    if (!runsPageVisible) return;
                    runConnectionValue.Text = IsExecutorOnlyMode() ? "Hub 재연결 중" : "Runtime 재연결 중";
                    runConnectionValue.ForeColor = System.Drawing.Color.FromArgb(150, 92, 35);
                    runWaitValue.Text = IsExecutorOnlyMode() ? "원격 JK hub 대기" : "로컬 JK runtime 대기";
                    if (userInitiated && IsExecutorOnlyMode())
                    {
                        runTaskValue.Text = "원격 JK hub에서 실행 상태를 아직 읽지 못했습니다: " + ex.Message;
                    }
                    else if (userInitiated)
                    {
                        runTaskValue.Text = "실행 상태를 아직 읽지 못했습니다: " + ex.Message;
                    }
                }));
            }
        });
    }

    private void ApplyRunSnapshot(JkExecution execution, int approvalCount, JkAuditEvent[] logs)
    {
        if (execution == null)
        {
            runGoalValue.Text = "활성 실행 없음";
            runTaskValue.Text = "새 @jk 작업을 시작하면 여기에 표시됩니다.";
            runMetaValue.Text = "IDLE";
            runWaitValue.Text = approvalCount > 0 ? "승인 대기 " + approvalCount + "건" : "대기 중";
            runDagValue.Text = "병렬 작업이 시작되면 의존관계를 표시합니다.";
            RenderRunLanes(null);
            RenderRunEvents(null, logs);
            return;
        }

        runGoalValue.Text = string.IsNullOrWhiteSpace(execution.goal) ? (execution.projectName ?? "JK run") : execution.goal;
        runTaskValue.Text = string.IsNullOrWhiteSpace(execution.task)
            ? (execution.lastProgressSummary ?? "현재 task 정보 없음")
            : execution.task;
        var elapsed = execution.massUlw != null && execution.massUlw.createdAt > 0 ? FormatElapsed(execution.massUlw.createdAt) : "—";
        var runningCount = execution.massUlw != null && execution.massUlw.runningLanes != null ? execution.massUlw.runningLanes.Length : 0;
        runMetaValue.Text = string.Format(
            "{0} · {1} · {2}/{3} 완료 · {4} 실행 · {5}",
            string.IsNullOrWhiteSpace(execution.phase) ? "IDLE" : execution.phase.ToUpperInvariant(),
            string.IsNullOrWhiteSpace(execution.verificationStatus) ? "UNKNOWN" : execution.verificationStatus.ToUpperInvariant(),
            execution.completedCount,
            execution.completedCount + execution.pendingCount,
            runningCount,
            elapsed);
        runWaitValue.Text = RunWaitReason(execution, approvalCount);
        runDagValue.Text = BuildDagSummary(execution.massUlw);
        RenderRunLanes(execution.massUlw);
        RenderRunEvents(execution.projectId, logs);
    }

    private string RunWaitReason(JkExecution execution, int approvalCount)
    {
        if (approvalCount > 0) return "승인 대기 " + approvalCount + "건";
        var mass = execution.massUlw;
        if (mass != null && mass.failedLanes != null && mass.failedLanes.Length > 0) return "실패: " + string.Join(", ", mass.failedLanes);
        if (mass != null && mass.blockedDependencies != null && mass.blockedDependencies.Length > 0) return "의존성 차단: " + string.Join(", ", mass.blockedDependencies);
        if (execution.recoveryNeeded) return "복구 단계 대기";
        if (string.Equals(execution.verificationStatus, "blocked", StringComparison.OrdinalIgnoreCase)) return "검증 차단";
        if (mass != null && mass.runningLanes != null && mass.runningLanes.Length > 0) return "실행 중: " + string.Join(", ", mass.runningLanes);
        if (execution.pendingCount > 0) return "다음 작업 " + execution.pendingCount + "개 대기";
        if (string.Equals(execution.verificationStatus, "pass", StringComparison.OrdinalIgnoreCase)) return "검증 완료";
        return "진행 상태 대기";
    }

    private static string BuildDagSummary(JkMassUlw mass)
    {
        if (mass == null || mass.lanes == null || mass.lanes.Length == 0) return "현재 실행은 단일 lane / 순차 흐름입니다.";
        if (mass.waves == null || mass.waves.Length == 0) return mass.lanes.Length + "개 lane · 의존관계 그래프";
        return string.Join("  →  ", mass.waves.OrderBy(wave => wave.index).Select(wave =>
            "Wave " + wave.index + ": " + string.Join(" | ", wave.laneIds ?? new string[0])).ToArray());
    }

    private void RenderRunLanes(JkMassUlw mass)
    {
        renderedRunMass = mass;
        runLaneFlow.SuspendLayout();
        foreach (Control control in runLaneFlow.Controls.Cast<Control>().ToArray()) control.Dispose();
        runLaneFlow.Controls.Clear();
        var lanes = mass == null || mass.lanes == null ? new JkMassUlwLane[0] : mass.lanes.OrderBy(lane => lane.wave ?? int.MaxValue).ThenBy(lane => lane.id).ToArray();
        if (lanes.Length == 0)
        {
            var empty = new Label();
            empty.Text = "병렬 lane 없음 · 현재 goal_loop 단계는 상단 상태에서 확인할 수 있습니다.";
            empty.ForeColor = System.Drawing.SystemColors.GrayText;
            empty.Padding = new Padding(8, 12, 8, 8);
            empty.Height = 54;
            empty.Width = Math.Max(280, runLaneFlow.ClientSize.Width - 30);
            runLaneFlow.Controls.Add(empty);
        }
        else
        {
            foreach (var lane in lanes) runLaneFlow.Controls.Add(NewRunLaneCard(lane, mass));
        }
        LayoutRunDag();
        runLaneFlow.ResumeLayout();
        runLaneFlow.Invalidate();
    }

    private Panel NewRunLaneCard(JkMassUlwLane lane, JkMassUlw mass)
    {
        var card = new Panel();
        card.Height = 92;
        card.Width = 230;
        card.Padding = new Padding(12, 10, 12, 8);
        var semanticStatus = RunSemanticStatus(lane, mass);
        card.BackColor = RunStatusColor(semanticStatus);
        card.Tag = lane;
        card.BorderStyle = BorderStyle.FixedSingle;
        var id = new Label();
        id.Text = lane.id ?? "lane";
        id.Font = new System.Drawing.Font("Segoe UI", 9, System.Drawing.FontStyle.Bold);
        id.SetBounds(12, 8, 104, 22);
        id.AutoEllipsis = true;
        var state = new Label();
        state.Text = RunStatusGlyph(semanticStatus) + " " + RunStatusLabel(semanticStatus).ToUpperInvariant() + (lane.wave.HasValue ? " · W" + lane.wave.Value : string.Empty);
        state.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
        state.SetBounds(126, 8, 91, 22);
        state.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        state.ForeColor = System.Drawing.Color.FromArgb(65, 72, 80);
        var task = new Label();
        task.Text = lane.task ?? "—";
        task.SetBounds(12, 31, 205, 28);
        task.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        task.AutoEllipsis = true;
        var dep = new Label();
        dep.Text = lane.dependsOn != null && lane.dependsOn.Length > 0 ? "from  " + string.Join(" · ", lane.dependsOn) : "root lane";
        dep.SetBounds(12, 65, 205, 18);
        dep.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        dep.ForeColor = System.Drawing.SystemColors.GrayText;
        dep.AutoEllipsis = true;
        card.Controls.Add(id);
        card.Controls.Add(state);
        card.Controls.Add(task);
        card.Controls.Add(dep);
        return card;
    }

    private static System.Drawing.Color RunStatusColor(string status)
    {
        switch ((status ?? string.Empty).ToLowerInvariant())
        {
            case "in-flight": return System.Drawing.Color.FromArgb(230, 240, 252);
            case "ready": return System.Drawing.Color.FromArgb(235, 242, 255);
            case "completed": return System.Drawing.Color.FromArgb(230, 244, 234);
            case "review": return System.Drawing.Color.FromArgb(242, 236, 252);
            case "failed": return System.Drawing.Color.FromArgb(252, 232, 232);
            case "blocked": return System.Drawing.Color.FromArgb(252, 244, 222);
            default: return System.Drawing.Color.FromArgb(242, 243, 245);
        }
    }

    private static string RunSemanticStatus(JkMassUlwLane lane, JkMassUlw mass)
    {
        var status = (lane == null ? null : lane.status) ?? "planned";
        if (!string.Equals(status, "planned", StringComparison.OrdinalIgnoreCase)) return status;
        var dependencies = lane.dependsOn ?? new string[0];
        if (dependencies.Length == 0) return "ready";
        var lanes = mass == null || mass.lanes == null ? new JkMassUlwLane[0] : mass.lanes;
        var allCompleted = dependencies.All(dependency => lanes.Any(candidate => candidate != null
            && string.Equals(candidate.id, dependency, StringComparison.OrdinalIgnoreCase)
            && string.Equals(candidate.status, "completed", StringComparison.OrdinalIgnoreCase)));
        return allCompleted ? "ready" : "planned";
    }

    private static string RunStatusLabel(string status)
    {
        switch ((status ?? string.Empty).ToLowerInvariant())
        {
            case "in-flight": return "running";
            case "completed": return "accepted";
            case "planned": return "waiting";
            default: return string.IsNullOrWhiteSpace(status) ? "waiting" : status;
        }
    }

    private static string RunStatusGlyph(string status)
    {
        switch ((status ?? string.Empty).ToLowerInvariant())
        {
            case "in-flight": return "▶";
            case "completed": return "✓";
            case "failed": return "!";
            case "blocked": return "×";
            case "review": return "◆";
            case "ready": return "●";
            default: return "○";
        }
    }

    private void LayoutRunDag()
    {
        if (runLaneFlow == null || runLaneFlow.IsDisposed) return;
        var cards = runLaneFlow.Controls.OfType<Panel>().Where(control => control.Tag is JkMassUlwLane).ToArray();
        if (cards.Length == 0)
        {
            foreach (Control control in runLaneFlow.Controls) control.Width = Math.Max(280, runLaneFlow.ClientSize.Width - 30);
            runLaneFlow.AutoScrollMinSize = System.Drawing.Size.Empty;
            return;
        }

        const int cardWidth = 230;
        const int cardHeight = 92;
        const int horizontalGap = 56;
        const int verticalGap = 22;
        const int padding = 16;
        var groups = cards.GroupBy(card => ((JkMassUlwLane)card.Tag).wave ?? 0).OrderBy(group => group.Key).ToArray();
        var maxRows = 0;
        for (var column = 0; column < groups.Length; column++)
        {
            var row = 0;
            foreach (var card in groups[column].OrderBy(control => ((JkMassUlwLane)control.Tag).id))
            {
                card.SetBounds(padding + column * (cardWidth + horizontalGap), padding + row * (cardHeight + verticalGap), cardWidth, cardHeight);
                row++;
            }
            maxRows = Math.Max(maxRows, row);
        }
        var contentWidth = padding * 2 + groups.Length * cardWidth + Math.Max(0, groups.Length - 1) * horizontalGap;
        var contentHeight = padding * 2 + maxRows * cardHeight + Math.Max(0, maxRows - 1) * verticalGap;
        runLaneFlow.AutoScrollMinSize = new System.Drawing.Size(contentWidth, contentHeight);
        runLaneFlow.Invalidate();
    }

    private void DrawRunDagEdges(System.Drawing.Graphics graphics)
    {
        if (renderedRunMass == null || renderedRunMass.lanes == null || runLaneFlow == null) return;
        var cards = runLaneFlow.Controls.OfType<Panel>()
            .Where(control => control.Tag is JkMassUlwLane)
            .ToDictionary(control => ((JkMassUlwLane)control.Tag).id ?? string.Empty, control => control, StringComparer.OrdinalIgnoreCase);
        graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        using (var pen = new System.Drawing.Pen(System.Drawing.Color.FromArgb(78, 92, 110), 2.25f))
        {
            pen.EndCap = System.Drawing.Drawing2D.LineCap.ArrowAnchor;
            foreach (var lane in renderedRunMass.lanes.Where(item => item != null && item.dependsOn != null))
            {
                Panel target;
                if (!cards.TryGetValue(lane.id ?? string.Empty, out target)) continue;
                foreach (var dependency in lane.dependsOn)
                {
                    Panel source;
                    if (!cards.TryGetValue(dependency ?? string.Empty, out source)) continue;
                    var start = new System.Drawing.Point(source.Right, source.Top + source.Height / 2);
                    var end = new System.Drawing.Point(target.Left, target.Top + target.Height / 2);
                    var bend = Math.Max(24, Math.Abs(end.X - start.X) / 2);
                    graphics.DrawBezier(pen,
                        start,
                        new System.Drawing.Point(start.X + bend, start.Y),
                        new System.Drawing.Point(end.X - bend, end.Y),
                        end);
                }
            }
        }
    }

    private void RenderRunEvents(string projectId, JkAuditEvent[] logs)
    {
        runEventList.BeginUpdate();
        runEventList.Items.Clear();
        var events = logs ?? new JkAuditEvent[0];
        if (!string.IsNullOrWhiteSpace(projectId))
        {
            var scoped = events.Where(item => item != null && string.Equals(item.projectId, projectId, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (scoped.Length > 0) events = scoped;
        }
        foreach (var item in events.Where(item => item != null).Take(14))
        {
            var row = new ListViewItem(FormatEventTime(item.ts));
            row.SubItems.Add(item.type ?? "event");
            row.SubItems.Add(item.detail ?? string.Empty);
            runEventList.Items.Add(row);
        }
        runEventList.EndUpdate();
    }

    private static string FormatEventTime(long epochMs)
    {
        if (epochMs <= 0) return "—";
        try { return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(epochMs).ToLocalTime().ToString("HH:mm:ss"); }
        catch { return "—"; }
    }

    private static string FormatElapsed(long epochMs)
    {
        if (epochMs <= 0) return "—";
        try
        {
            var started = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(epochMs);
            var elapsed = DateTime.UtcNow - started;
            if (elapsed.TotalHours >= 1) return ((int)elapsed.TotalHours) + "h " + elapsed.Minutes + "m";
            if (elapsed.TotalMinutes >= 1) return ((int)elapsed.TotalMinutes) + "m " + elapsed.Seconds + "s";
            return Math.Max(0, elapsed.Seconds) + "s";
        }
        catch { return "—"; }
    }

    private Panel NewConsolePage(string title, string description)
    {
        var panel = new Panel();
        panel.BackColor = System.Drawing.Color.White;
        panel.AutoScroll = true;
        var titleLabel = NewLabel(title, 28, 24, 650);
        titleLabel.Height = 38;
        titleLabel.Font = new System.Drawing.Font("Segoe UI", 20, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(titleLabel);
        var descriptionLabel = NewLabel(description, 30, 68, 720);
        descriptionLabel.Height = 42;
        descriptionLabel.ForeColor = System.Drawing.SystemColors.GrayText;
        panel.Controls.Add(descriptionLabel);
        return panel;
    }

    private void ShowProjectsPage()
    {
        if (!RoleApiAvailable())
        {
            ShowRoleApiUnavailable();
            return;
        }

        try { RefreshRoleData(consoleProjectId); }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Could not load Roles.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var panel = NewConsolePage("Projects", "Choose a project Role. This changes Role context only; it does not increase the project lease.");

        var projectBox = new ComboBox();
        projectBox.DropDownStyle = ComboBoxStyle.DropDownList;
        projectBox.SetBounds(30, 118, 420, 28);
        projectBox.Items.AddRange(cachedProjects.Cast<object>().ToArray());
        var projectIndex = Array.FindIndex(cachedProjects, project => project != null && project.projectId == consoleProjectId);
        if (projectIndex >= 0) projectBox.SelectedIndex = projectIndex;
        panel.Controls.Add(projectBox);

        var roleTitle = NewLabel("ROLE", 30, 176, 120);
        roleTitle.Font = new System.Drawing.Font("Segoe UI", 8, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(roleTitle);
        var roleBox = new ComboBox();
        roleBox.DropDownStyle = ComboBoxStyle.DropDownList;
        roleBox.SetBounds(30, 202, 295, 28);
        panel.Controls.Add(roleBox);

        var setDefault = NewButton("Set as Default", 335, 200, 130);
        panel.Controls.Add(setDefault);

        var modeTitle = NewLabel("MODE", 500, 176, 120);
        modeTitle.Font = new System.Drawing.Font("Segoe UI", 8, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(modeTitle);
        var modeValue = NewLabel("—", 500, 202, 200);
        modeValue.Font = new System.Drawing.Font("Segoe UI", 11, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(modeValue);

        var skillsTitle = NewLabel("SKILLS", 30, 258, 120);
        skillsTitle.Font = new System.Drawing.Font("Segoe UI", 8, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(skillsTitle);
        var skillsValue = NewLabel("—", 30, 284, 680);
        skillsValue.Height = 32;
        panel.Controls.Add(skillsValue);

        var instructionsTitle = NewLabel("ROLE INSTRUCTIONS", 30, 336, 200);
        instructionsTitle.Font = new System.Drawing.Font("Segoe UI", 8, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(instructionsTitle);
        var instructionsBox = new TextBox();
        instructionsBox.SetBounds(30, 362, 680, 148);
        instructionsBox.Multiline = true;
        instructionsBox.ReadOnly = true;
        instructionsBox.ScrollBars = ScrollBars.Vertical;
        panel.Controls.Add(instructionsBox);

        var note = NewLabel("Effective permission = Project permission ∩ Role permission. A Role can reduce access, never expand it.", 30, 530, 700);
        note.Height = 42;
        note.ForeColor = System.Drawing.SystemColors.GrayText;
        panel.Controls.Add(note);

        var suppressRoleChange = false;
        Action fillRoleBox = delegate
        {
            suppressRoleChange = true;
            roleBox.Items.Clear();
            roleBox.Items.AddRange(cachedRoles.Cast<object>().ToArray());
            var activeRoleId = cachedRoleContext != null && cachedRoleContext.role != null ? cachedRoleContext.role.id : "default";
            var roleIndex = Array.FindIndex(cachedRoles, role => role != null && role.id == activeRoleId);
            if (roleIndex >= 0) roleBox.SelectedIndex = roleIndex;
            if (cachedRoleContext != null)
            {
                modeValue.Text = PermissionLabel(cachedRoleContext.effectivePermission);
                skillsValue.Text = cachedRoleContext.role != null && cachedRoleContext.role.skills != null && cachedRoleContext.role.skills.Length > 0
                    ? string.Join(" · ", cachedRoleContext.role.skills)
                    : "—";
                instructionsBox.Text = cachedRoleContext.role == null ? string.Empty : (cachedRoleContext.role.instructions ?? string.Empty);
                var defaultRole = cachedRoles.FirstOrDefault(role => role != null && role.id == cachedRoleContext.defaultRoleId);
                note.Text = "Effective permission = Project permission ∩ Role permission. Default: "
                    + (defaultRole != null ? defaultRole.name : "Default")
                    + " · source: " + (cachedRoleContext.selectionSource ?? "global-default") + ".";
            }
            else
            {
                modeValue.Text = "No active lease";
                skillsValue.Text = "—";
                instructionsBox.Text = string.Empty;
            }
            suppressRoleChange = false;
        };
        fillRoleBox();

        projectBox.SelectedIndexChanged += delegate
        {
            if (projectBox.SelectedItem == null) return;
            try
            {
                var selectedProject = (JkProject)projectBox.SelectedItem;
                RefreshRoleData(selectedProject.projectId);
                fillRoleBox();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not load project Role.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };

        roleBox.SelectedIndexChanged += delegate
        {
            if (suppressRoleChange || roleBox.SelectedItem == null || string.IsNullOrWhiteSpace(consoleProjectId)) return;
            try
            {
                var selectedRole = (JkRole)roleBox.SelectedItem;
                var response = RoleApiRequest<JkRoleMutationResponse>(
                    "POST",
                    "/projects/" + Uri.EscapeDataString(consoleProjectId) + "/role",
                    new JkRoleSelectRequest { roleId = selectedRole.id });
                cachedRoleContext = response == null ? null : response.context;
                fillRoleBox();
                RefreshDashboardRoleSummary();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not select Role.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };

        setDefault.Click += delegate
        {
            if (roleBox.SelectedItem == null || string.IsNullOrWhiteSpace(consoleProjectId)) return;
            try
            {
                var selectedRole = (JkRole)roleBox.SelectedItem;
                var response = RoleApiRequest<JkRoleMutationResponse>(
                    "POST",
                    "/projects/" + Uri.EscapeDataString(consoleProjectId) + "/default-role",
                    new JkRoleSelectRequest { roleId = selectedRole.id });
                cachedRoleContext = response == null ? null : response.context;
                fillRoleBox();
                RefreshDashboardRoleSummary();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not set project default Role.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };

        ShowConsolePage(panel);
    }

    private void ShowRolesPage()
    {
        if (!RoleApiAvailable())
        {
            ShowRoleApiUnavailable();
            return;
        }

        try { RefreshRoleData(consoleProjectId); }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Could not load Roles.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var panel = NewConsolePage("Roles", "Manage reusable execution roles here. Selecting a row does not activate it; use Apply to Project. Built-ins are immutable.");
        var activeRoleName = cachedRoleContext != null && cachedRoleContext.role != null
            ? cachedRoleContext.role.name
            : "Default";
        var defaultRole = cachedRoleContext == null
            ? null
            : cachedRoles.FirstOrDefault(role => role != null && role.id == cachedRoleContext.defaultRoleId);
        var activeProjectName = cachedProjects.FirstOrDefault(project => project != null && project.projectId == consoleProjectId);
        var activeSummary = NewLabel(
            "ACTIVE FOR " + (activeProjectName != null ? activeProjectName.name : (consoleProjectId ?? "project")) + ":  " + activeRoleName
            + "    DEFAULT: " + (defaultRole != null ? defaultRole.name : "Default"),
            30,
            108,
            700);
        activeSummary.Font = new System.Drawing.Font("Segoe UI", 9, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(activeSummary);

        var list = new ListView();
        list.SetBounds(30, 142, 700, 350);
        list.View = View.Details;
        list.FullRowSelect = true;
        list.HideSelection = false;
        list.Columns.Add("Role", 135);
        list.Columns.Add("Description", 220);
        list.Columns.Add("Permission", 100);
        list.Columns.Add("Type", 80);
        list.Columns.Add("Skills", 165);
        ListViewItem activeItem = null;
        foreach (var role in cachedRoles)
        {
            var item = new ListViewItem(role.name ?? role.id);
            item.SubItems.Add(role.description ?? string.Empty);
            item.SubItems.Add(PermissionLabel(role.permissionPreset));
            item.SubItems.Add(role.builtIn ? "Built-in" : "Custom");
            item.SubItems.Add(role.skills == null ? string.Empty : string.Join(", ", role.skills));
            item.Tag = role;
            if (cachedRoleContext != null && cachedRoleContext.role != null && cachedRoleContext.role.id == role.id)
            {
                item.Text = "● " + item.Text;
                item.Font = new System.Drawing.Font(list.Font, System.Drawing.FontStyle.Bold);
                activeItem = item;
            }
            list.Items.Add(item);
        }
        panel.Controls.Add(list);
        if (activeItem != null)
        {
            activeItem.Selected = true;
            activeItem.EnsureVisible();
        }

        var apply = NewButton("Apply to Project", 30, 514, 140);
        var create = NewButton("+ Create Role", 180, 514, 126);
        var edit = NewButton("Edit", 316, 514, 76);
        var duplicate = NewButton("Duplicate", 402, 514, 94);
        var refresh = NewButton("Refresh", 506, 514, 82);
        var remove = NewButton("Delete", 30, 554, 82);
        var exportRoles = NewButton("Export", 122, 554, 82);
        var importRoles = NewButton("Import", 214, 554, 82);
        panel.Controls.Add(apply);
        panel.Controls.Add(create);
        panel.Controls.Add(edit);
        panel.Controls.Add(duplicate);
        panel.Controls.Add(refresh);
        panel.Controls.Add(remove);
        panel.Controls.Add(exportRoles);
        panel.Controls.Add(importRoles);

        apply.Click += delegate
        {
            if (list.SelectedItems.Count == 0)
            {
                MessageBox.Show(this, "Select a Role first.", "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (string.IsNullOrWhiteSpace(consoleProjectId))
            {
                MessageBox.Show(this, "Select a project from Projects first.", "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                var role = (JkRole)list.SelectedItems[0].Tag;
                var response = RoleApiRequest<JkRoleMutationResponse>(
                    "POST",
                    "/projects/" + Uri.EscapeDataString(consoleProjectId) + "/role",
                    new JkRoleSelectRequest { roleId = role.id });
                cachedRoleContext = response == null ? null : response.context;
                RefreshDashboardRoleSummary();
                ShowRolesPage();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not apply Role.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };

        create.Click += delegate
        {
            if (ShowRoleEditor(null, false)) ShowRolesPage();
        };
        edit.Click += delegate
        {
            if (list.SelectedItems.Count == 0) return;
            var role = (JkRole)list.SelectedItems[0].Tag;
            if (role.builtIn)
            {
                MessageBox.Show(this, "Built-in Roles cannot be edited. Duplicate it to create your own Role.", "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (ShowRoleEditor(role, false)) ShowRolesPage();
        };
        duplicate.Click += delegate
        {
            if (list.SelectedItems.Count == 0) return;
            if (ShowRoleEditor((JkRole)list.SelectedItems[0].Tag, true)) ShowRolesPage();
        };
        remove.Click += delegate
        {
            if (list.SelectedItems.Count == 0) return;
            var role = (JkRole)list.SelectedItems[0].Tag;
            if (role.builtIn)
            {
                MessageBox.Show(this, "Built-in Roles cannot be deleted.", "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (MessageBox.Show(this, "Delete Role '" + role.name + "'? Project references will fall back to their next available default.", "JK Roles", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            try
            {
                RoleApiRequest<JkRoleMutationResponse>("DELETE", "/roles/" + Uri.EscapeDataString(role.id), null);
                RefreshRoleData(consoleProjectId);
                RefreshDashboardRoleSummary();
                ShowRolesPage();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not delete Role.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };
        exportRoles.Click += delegate
        {
            try
            {
                var response = RoleApiGet<JkRoleExportResponse>("/roles/export");
                if (response == null || response.bundle == null) return;
                using (var dialog = new SaveFileDialog())
                {
                    dialog.Filter = "JK Role bundle (*.json)|*.json|All files (*.*)|*.*";
                    dialog.FileName = "jk-roles.json";
                    if (dialog.ShowDialog(this) != DialogResult.OK) return;
                    File.WriteAllText(dialog.FileName, new JavaScriptSerializer().Serialize(response.bundle), Encoding.UTF8);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not export Roles.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };
        importRoles.Click += delegate
        {
            try
            {
                using (var dialog = new OpenFileDialog())
                {
                    dialog.Filter = "JK Role bundle (*.json)|*.json|All files (*.*)|*.*";
                    if (dialog.ShowDialog(this) != DialogResult.OK) return;
                    var bundle = new JavaScriptSerializer().Deserialize<JkRoleBundle>(File.ReadAllText(dialog.FileName, Encoding.UTF8));
                    RoleApiRequest<JkRoleMutationResponse>("POST", "/roles/import", bundle);
                }
                RefreshRoleData(consoleProjectId);
                ShowRolesPage();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not import Roles.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };
        refresh.Click += delegate { ShowRolesPage(); };
        list.DoubleClick += delegate
        {
            if (list.SelectedItems.Count == 0) return;
            var role = (JkRole)list.SelectedItems[0].Tag;
            if (ShowRoleEditor(role, role.builtIn)) ShowRolesPage();
        };

        ShowConsolePage(panel);
    }

    private void ShowSkillsPage()
    {
        if (RoleApiAvailable())
        {
            try { RefreshRoleData(consoleProjectId); } catch { }
        }
        var panel = NewConsolePage("Skills", "Roles v1 reuses Skills as execution context. Marketplace/install management stays separate.");
        var roleTitle = NewLabel("ACTIVE ROLE", 30, 126, 160);
        roleTitle.Font = new System.Drawing.Font("Segoe UI", 8, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(roleTitle);
        var roleValue = NewLabel(cachedRoleContext != null && cachedRoleContext.role != null ? cachedRoleContext.role.name : "Default", 30, 154, 520);
        roleValue.Font = new System.Drawing.Font("Segoe UI", 13, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(roleValue);
        var skillsTitle = NewLabel("SKILLS", 30, 212, 160);
        skillsTitle.Font = new System.Drawing.Font("Segoe UI", 8, System.Drawing.FontStyle.Bold);
        panel.Controls.Add(skillsTitle);
        var skills = cachedRoleContext != null && cachedRoleContext.role != null && cachedRoleContext.role.skills != null && cachedRoleContext.role.skills.Length > 0
            ? string.Join(" · ", cachedRoleContext.role.skills)
            : "No role-specific skills";
        var skillsValue = NewLabel(skills, 30, 240, 680);
        skillsValue.Height = 60;
        panel.Controls.Add(skillsValue);
        ShowConsolePage(panel);
    }

    private bool ShowRoleEditor(JkRole role, bool duplicate)
    {
        using (var form = new Form())
        {
            form.Text = role == null ? "Create Role" : (duplicate ? "Duplicate Role" : "Edit Role");
            form.Width = 640;
            form.Height = 760;
            form.StartPosition = FormStartPosition.CenterParent;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;

            form.Controls.Add(NewLabel("Name", 24, 20, 150));
            var nameBox = new TextBox();
            nameBox.SetBounds(24, 44, 570, 26);
            nameBox.Text = role == null ? string.Empty : (duplicate ? (role.name + " Copy") : role.name);
            form.Controls.Add(nameBox);

            form.Controls.Add(NewLabel("Description", 24, 82, 150));
            var descriptionBox = new TextBox();
            descriptionBox.SetBounds(24, 106, 570, 26);
            descriptionBox.Text = role == null ? string.Empty : (role.description ?? string.Empty);
            form.Controls.Add(descriptionBox);

            form.Controls.Add(NewLabel("Instructions", 24, 144, 150));
            var instructionsBox = new TextBox();
            instructionsBox.SetBounds(24, 168, 570, 128);
            instructionsBox.Multiline = true;
            instructionsBox.ScrollBars = ScrollBars.Vertical;
            instructionsBox.Text = role == null ? string.Empty : (role.instructions ?? string.Empty);
            form.Controls.Add(instructionsBox);

            form.Controls.Add(NewLabel("Default permission", 24, 314, 180));
            var permissionBox = new ComboBox();
            permissionBox.SetBounds(24, 338, 270, 28);
            permissionBox.DropDownStyle = ComboBoxStyle.DropDownList;
            var permissionOptions = new[]
            {
                new JkOption { Value = "inherit", Label = "Project Default (inherit)" },
                new JkOption { Value = "read-only", Label = "Read Only" },
                new JkOption { Value = "tests-only", Label = "Tests Only" },
                new JkOption { Value = "full-write", Label = "Full Write" },
                new JkOption { Value = "image-only", Label = "Image Only" },
            };
            permissionBox.Items.AddRange(permissionOptions.Cast<object>().ToArray());
            var targetPermission = role == null ? "read-only" : role.permissionPreset;
            var permissionIndex = Array.FindIndex(permissionOptions, option => option.Value == targetPermission);
            permissionBox.SelectedIndex = permissionIndex >= 0 ? permissionIndex : 1;
            form.Controls.Add(permissionBox);

            form.Controls.Add(NewLabel("Tools", 324, 314, 180));
            var toolsList = new CheckedListBox();
            toolsList.SetBounds(324, 338, 270, 142);
            toolsList.CheckOnClick = true;
            var toolValues = new[] { "code_search", "file_read", "tests", "file_write", "git", "browser" };
            var toolLabels = new[] { "Code Search", "File Read", "Tests / E2E", "File Write", "Git", "Browser / Open URL" };
            for (var i = 0; i < toolValues.Length; i++)
            {
                var index = toolsList.Items.Add(toolLabels[i]);
                var selected = role == null
                    ? toolValues[i] == "code_search" || toolValues[i] == "file_read"
                    : role.tools != null && role.tools.Contains(toolValues[i]);
                toolsList.SetItemChecked(index, selected);
            }
            form.Controls.Add(toolsList);

            form.Controls.Add(NewLabel("Skills", 24, 398, 150));
            var skillsList = new CheckedListBox();
            skillsList.SetBounds(24, 422, 270, 156);
            skillsList.CheckOnClick = true;
            var defaultSkills = new[] { "Backend", "Security", "QA", "E2E", "Web", "Research", "Architecture", "Planning", "Implementation", "Debugging", "Testing", "Review" };
            var allSkills = new List<string>(defaultSkills);
            if (role != null && role.skills != null)
            {
                foreach (var skill in role.skills)
                {
                    if (!allSkills.Contains(skill)) allSkills.Add(skill);
                }
            }
            foreach (var skill in allSkills)
            {
                var index = skillsList.Items.Add(skill);
                if (role != null && role.skills != null && role.skills.Contains(skill)) skillsList.SetItemChecked(index, true);
            }
            form.Controls.Add(skillsList);

            form.Controls.Add(NewLabel("Workflow preset", 324, 498, 190));
            var workflowPresetBox = new ComboBox();
            workflowPresetBox.SetBounds(324, 522, 270, 28);
            workflowPresetBox.DropDownStyle = ComboBoxStyle.DropDownList;
            var workflowOptions = new List<JkWorkflowPreset>();
            workflowOptions.Add(new JkWorkflowPreset { id = "custom", name = "Custom", preference = null });
            workflowOptions.AddRange(cachedWorkflowPresets ?? new JkWorkflowPreset[0]);
            workflowPresetBox.Items.AddRange(workflowOptions.Cast<object>().ToArray());
            var currentWorkflow = role == null ? string.Empty : (role.workflowPreference ?? string.Empty);
            var workflowPresetIndex = workflowOptions.FindIndex(option => !string.IsNullOrWhiteSpace(option.preference) && option.preference == currentWorkflow);
            workflowPresetBox.SelectedIndex = workflowPresetIndex >= 0 ? workflowPresetIndex : 0;
            form.Controls.Add(workflowPresetBox);

            var workflowBox = new TextBox();
            workflowBox.SetBounds(324, 558, 270, 70);
            workflowBox.Multiline = true;
            workflowBox.ScrollBars = ScrollBars.Vertical;
            workflowBox.Text = currentWorkflow;
            form.Controls.Add(workflowBox);

            workflowPresetBox.SelectedIndexChanged += delegate
            {
                var selectedPreset = workflowPresetBox.SelectedItem as JkWorkflowPreset;
                if (selectedPreset != null && selectedPreset.id != "custom" && !string.IsNullOrWhiteSpace(selectedPreset.preference))
                {
                    workflowBox.Text = selectedPreset.preference;
                }
            };

            var cancel = NewButton("Cancel", 410, 650, 84);
            cancel.DialogResult = DialogResult.Cancel;
            form.Controls.Add(cancel);
            var save = NewButton("Save Role", 504, 650, 90);
            form.Controls.Add(save);
            form.CancelButton = cancel;

            var saved = false;
            save.Click += delegate
            {
                if (string.IsNullOrWhiteSpace(nameBox.Text))
                {
                    MessageBox.Show(form, "Role name is required.", "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                var selectedTools = new List<string>();
                for (var i = 0; i < toolValues.Length; i++)
                {
                    if (toolsList.GetItemChecked(i)) selectedTools.Add(toolValues[i]);
                }
                var selectedSkills = new List<string>();
                foreach (var checkedItem in skillsList.CheckedItems) selectedSkills.Add(checkedItem.ToString());
                var selectedPermission = (JkOption)permissionBox.SelectedItem;
                var request = new JkRoleSaveRequest
                {
                    name = nameBox.Text.Trim(),
                    description = descriptionBox.Text.Trim(),
                    instructions = instructionsBox.Text.Trim(),
                    permissionPreset = selectedPermission.Value,
                    tools = selectedTools.ToArray(),
                    skills = selectedSkills.ToArray(),
                    workflowPreference = workflowBox.Text.Trim(),
                };
                try
                {
                    if (role != null && !duplicate && !role.builtIn)
                    {
                        RoleApiRequest<JkRoleMutationResponse>("PUT", "/roles/" + Uri.EscapeDataString(role.id), request);
                    }
                    else
                    {
                        RoleApiRequest<JkRoleMutationResponse>("POST", "/roles", request);
                    }
                    saved = true;
                    form.DialogResult = DialogResult.OK;
                    form.Close();
                }
                catch (Exception ex)
                {
                    MessageBox.Show(form, "Could not save Role.\r\n\r\n" + ex.Message, "JK Roles", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            };

            form.ShowDialog(this);
            if (saved)
            {
                try { RefreshRoleData(consoleProjectId); } catch { }
            }
            return saved;
        }
    }

    private void ShowSettings()
    {
        using (var form = new Form())
        {
            form.Text = L("settingsTitle");
            form.Width = 640;
            form.Height = 670;
            form.StartPosition = FormStartPosition.CenterParent;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.BackColor = JkSurface;
            form.Font = UiFont(9.5f);
            form.HandleCreated += delegate { ApplyWindowChrome(form.Handle); };

            var title = NewLabel(L("settingsTitle"), 24, 18, 500);
            title.Font = new System.Drawing.Font(title.Font.FontFamily, 14, System.Drawing.FontStyle.Bold);
            title.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
            form.Controls.Add(title);

            form.Controls.Add(NewLabel(L("language"), 24, 62, 150));
            var languageBox = new ComboBox();
            languageBox.DropDownStyle = ComboBoxStyle.DropDownList;
            languageBox.Items.AddRange(LanguageOptionNames.Cast<object>().ToArray());
            languageBox.SetBounds(180, 58, 230, 28);
            languageBox.SelectedIndex = LanguageOptionIndex();
            form.Controls.Add(languageBox);

            form.Controls.Add(NewLabel(L("projectFolder"), 24, 102, 150));
            var projectBox = new TextBox();
            projectBox.Text = selectedProjectPath ?? string.Empty;
            projectBox.ReadOnly = true;
            projectBox.SetBounds(180, 98, 250, 24);
            form.Controls.Add(projectBox);
            var browseButton = NewButton(L("browse"), 440, 96, 82);
            browseButton.Click += delegate
            {
                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = L("projectFolder");
                    dialog.ShowNewFolderButton = true;
                    var initial = projectBox.Text.Length > 0 ? projectBox.Text : defaultWorkspace;
                    if (Directory.Exists(initial)) dialog.SelectedPath = initial;
                    if (dialog.ShowDialog(form) == DialogResult.OK)
                    {
                        var path = Path.GetFullPath(dialog.SelectedPath);
                        Directory.CreateDirectory(path);
                        projectBox.Text = path;
                    }
                }
            };
            form.Controls.Add(browseButton);

            var launchCheck = new CheckBox();
            launchCheck.Text = L("launchWindowsSetting");
            launchCheck.Checked = launchAtStartup;
            launchCheck.SetBounds(180, 138, 320, 24);
            form.Controls.Add(launchCheck);

            var startCheck = new CheckBox();
            startCheck.Text = L("startOnOpenSetting");
            startCheck.Checked = startMcpOnOpen;
            startCheck.SetBounds(180, 166, 320, 24);
            form.Controls.Add(startCheck);

            var updatesCheck = new CheckBox();
            updatesCheck.Text = L("autoUpdatesSetting");
            updatesCheck.Checked = autoCheckUpdates;
            updatesCheck.SetBounds(180, 194, 320, 24);
            form.Controls.Add(updatesCheck);

            var tunnelCheck = new CheckBox();
            tunnelCheck.Text = L("publicTunnelSetting");
            tunnelCheck.Checked = publicTunnelEnabled;
            tunnelCheck.SetBounds(180, 222, 390, 24);
            form.Controls.Add(tunnelCheck);

            form.Controls.Add(NewLabel(L("publicHostname"), 24, 262, 150));
            var hostBox = new TextBox();
            hostBox.Text = configuredPublicHost ?? string.Empty;
            hostBox.SetBounds(180, 258, 342, 24);
            form.Controls.Add(hostBox);

            var hostHint = NewLabel(L("publicHostnameHint"), 180, 288, 342);
            hostHint.SetBounds(180, 286, 342, 42);
            hostHint.ForeColor = System.Drawing.SystemColors.GrayText;
            form.Controls.Add(hostHint);

            form.Controls.Add(NewLabel(L("localPort"), 24, 342, 150));
            var portBox = new NumericUpDown();
            portBox.Minimum = 1;
            portBox.Maximum = 65535;
            portBox.Value = Math.Min(65535, Math.Max(1, port));
            portBox.SetBounds(180, 338, 120, 24);
            form.Controls.Add(portBox);

            form.Controls.Add(NewLabel(L("githubRepositoryURL"), 24, 382, 150));
            var repoBox = new TextBox();
            repoBox.Text = githubRepoUrl ?? string.Empty;
            repoBox.SetBounds(180, 378, 342, 24);
            form.Controls.Add(repoBox);

            var copyConnector = NewButton(L("copyConnector"), 24, 426, 156);
            copyConnector.Click += delegate { CopyMcpUrl(); };
            form.Controls.Add(copyConnector);

            var copyOwner = NewButton(L("copyOwnerToken"), 194, 426, 156);
            copyOwner.Enabled = !string.IsNullOrEmpty(ownerToken);
            copyOwner.Click += delegate { CopyOwnerToken(); };
            form.Controls.Add(copyOwner);

            var generateOwner = NewButton(L("autoGenerateToken"), 364, 426, 158);
            generateOwner.Click += delegate { AutoGenerateOwnerToken(); };
            form.Controls.Add(generateOwner);

            var localHealth = NewButton(L("openLocalHealth"), 24, 464, 156);
            localHealth.Click += delegate { OpenLocalHealth(); };
            form.Controls.Add(localHealth);

            var publicHealth = NewButton(L("openPublicHealth"), 194, 464, 156);
            publicHealth.Click += delegate { OpenPublicHealth(); };
            form.Controls.Add(publicHealth);

            var logs = NewButton(L("showLogs"), 364, 464, 158);
            logs.Click += delegate { ShowLogs(); };
            form.Controls.Add(logs);

            var github = NewButton(L("openGithub"), 24, 502, 156);
            github.Click += delegate { OpenGithub(); };
            form.Controls.Add(github);

            var checkUpdates = NewButton(L("checkUpdates"), 194, 502, 156);
            checkUpdates.Click += delegate { CheckUpdates(true); };
            form.Controls.Add(checkUpdates);

            var about = NewButton(L("about"), 364, 502, 158);
            about.Click += delegate
            {
                MessageBox.Show(
                    form,
                    "JK\r\nLocal coding bridge for ChatGPT\r\n\r\nIndependent project; not affiliated with OpenAI.",
                    "About JK",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            };
            form.Controls.Add(about);

            var copyright = NewLabel("JK © 2026 Anjingyeong. See ACKNOWLEDGEMENTS.md for historical attribution.", 24, 560, 500);
            form.Controls.Add(copyright);

            var cancel = NewButton(L("cancel"), 356, 554, 78);
            cancel.DialogResult = DialogResult.Cancel;
            form.Controls.Add(cancel);

            var save = NewButton(L("save"), 444, 554, 78);
            save.DialogResult = DialogResult.OK;
            form.AcceptButton = save;
            form.CancelButton = cancel;
            form.Controls.Add(save);

            ShowFromTray();
            if (form.ShowDialog(this) != DialogResult.OK) return;

            var wasRunning = IsManagedProcessRunning();
            selectedProjectPath = string.IsNullOrWhiteSpace(projectBox.Text) ? null : Path.GetFullPath(projectBox.Text);
            launchAtStartup = launchCheck.Checked;
            startMcpOnOpen = startCheck.Checked;
            autoCheckUpdates = updatesCheck.Checked;
            var previousPublicHost = configuredPublicHost;
            configuredPublicHost = NormalizePublicHost(hostBox.Text);
            if (!string.Equals(previousPublicHost, configuredPublicHost, StringComparison.OrdinalIgnoreCase))
            {
                mcpUrl = null;
            }
            // A fixed hostname is itself an explicit request to expose the
            // local MCP through an externally-managed tunnel/reverse proxy.
            publicTunnelEnabled = tunnelCheck.Checked || !string.IsNullOrWhiteSpace(configuredPublicHost);
            port = (int)portBox.Value;
            githubRepoUrl = string.IsNullOrWhiteSpace(repoBox.Text) ? "https://github.com/Anjingyeong/jk-mcp" : repoBox.Text.Trim();
            preferredLanguage = LanguageOptionCodes[Math.Max(0, languageBox.SelectedIndex)];
            SaveSettings();
            RefreshTrayState();
            if (wasRunning) RestartServer();
        }
    }

    private void RefreshTrayState()
    {
        var running = IsManagedProcessRunning();
        statusTrayItem.Text = "JK: " + (running ? L("statusOn") : L("statusOff"));
        toggleTrayItem.Text = running ? L("stopMCP") : L("startMCP");
        stopButton.Text = running ? L("stopMCP") : L("startMCP");
        stopButton.Enabled = true;
        UpdateStatusPill(running);
        restartTrayItem.Enabled = true;
        restartTrayItem.Text = L("restartMCP");
        var connector = DisplayConnectorUrl();
        if (!string.IsNullOrEmpty(connector) && !string.IsNullOrWhiteSpace(configuredPublicHost))
        {
            urlBox.Text = connector;
        }
        else if (!string.IsNullOrEmpty(connector) && (string.IsNullOrEmpty(urlBox.Text) || urlBox.Text == "Connector URL will appear here"))
        {
            urlBox.Text = connector;
        }
        else if (string.IsNullOrEmpty(connector) && IsPublicTunnelEnabledForLaunch() && running)
        {
            urlBox.Text = "Waiting for Cloudflare connector URL...";
        }
        copyButton.Enabled = !string.IsNullOrEmpty(connector);
        copyButton.Text = L("copyConnector");
        copyOwnerTokenButton.Text = L("copyOwnerToken");
        copyOwnerTokenButton.Enabled = !string.IsNullOrEmpty(ownerToken);
        autoGenerateOwnerTokenButton.Text = L("autoGenerateToken");
        autoGenerateOwnerTokenButton.Enabled = !exitRequested && !autoGenerateOwnerTokenOnNextStart;
        openLogButton.Text = L("showLogs");
        settingsTrayItem.Text = L("settingsMenu");
        quitTrayItem.Text = L("quit");
    }

    private void ToggleServer()
    {
        if (IsManagedProcessRunning())
        {
            StopProcessTree();
            RefreshTrayState();
            return;
        }

        stopping = false;
        StartLauncher();
    }

    private void RestartServer()
    {
        if (exitRequested) return;
        AppendLog("[JK] Restarting MCP runtime...");
        StopProcessTree();

        var timer = new Timer();
        timer.Interval = 1200;
        timer.Tick += delegate
        {
            timer.Stop();
            timer.Dispose();
            stopping = false;
            StartLauncher();
        };
        timer.Start();
    }

    private static void PruneLauncherLogs(string directory)
    {
        try
        {
            var dir = new DirectoryInfo(directory);
            if (!dir.Exists) return;

            var cutoff = DateTime.UtcNow.AddDays(-MaxLauncherLogAgeDays);
            foreach (var file in dir.GetFiles("launcher-*.log"))
            {
                if (file.LastWriteTimeUtc < cutoff)
                {
                    TryDelete(file);
                }
            }

            var remaining = dir.GetFiles("launcher-*.log")
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .ToArray();

            for (var i = MaxLauncherLogFiles; i < remaining.Length; i++)
            {
                TryDelete(remaining[i]);
            }

            long total = 0;
            foreach (var file in dir.GetFiles("launcher-*.log").OrderByDescending(file => file.LastWriteTimeUtc))
            {
                total += file.Length;
                if (total > MaxLauncherLogTotalBytes)
                {
                    TryDelete(file);
                }
            }
        }
        catch
        {
            // Log cleanup is best-effort; startup must never fail because of it.
        }
    }

    private static void TryDelete(FileInfo file)
    {
        try
        {
            file.Delete();
        }
        catch
        {
            // Another process may still be reading the log.
        }
    }

    private void TrimCurrentLogIfNeeded()
    {
        try
        {
            var file = new FileInfo(logFile);
            if (!file.Exists || file.Length <= MaxLauncherLogFileBytes) return;

            var lines = File.ReadAllLines(logFile, Encoding.UTF8);
            var keep = Math.Min(lines.Length, MaxLauncherLogLinesAfterTrim);
            var trimmed = new string[keep + 1];
            trimmed[0] = "[JK] Older log output trimmed to keep this file bounded.";
            Array.Copy(lines, lines.Length - keep, trimmed, 1, keep);
            File.WriteAllLines(logFile, trimmed, Encoding.UTF8);
        }
        catch
        {
            // Keep the launcher running even if log trimming fails.
        }
    }

    private void TrimVisibleLogIfNeeded()
    {
        if (logBox.TextLength <= MaxVisibleLogCharacters) return;

        var text = logBox.Text;
        var keep = MaxVisibleLogCharacters / 2;
        var start = Math.Max(0, text.Length - keep);
        logBox.Text = "[older on-screen log output trimmed]" + Environment.NewLine + text.Substring(start);
        logBox.SelectionStart = logBox.TextLength;
        logBox.ScrollToCaret();
    }

    private void CopyMcpUrl()
    {
        var connector = DisplayConnectorUrl();
        if (string.IsNullOrEmpty(connector)) return;

        if (CopyTextToClipboard(connector, L("connectorUrlLabel"), urlBox) && IsTemporaryTunnelUrl(connector))
        {
            statusLabel.Text = L("temporaryTunnelCopied");
        }
    }

    private void CopyOwnerToken()
    {
        if (string.IsNullOrEmpty(ownerToken))
        {
            statusLabel.Text = L("ownerTokenNotReady");
            return;
        }

        CopyTextToClipboard(ownerToken, L("ownerTokenLabel"), ownerTokenBox);
    }

    private bool CopyTextToClipboard(string value, string label, TextBox fallbackBox)
    {
        Exception lastError;
        if (TrySetClipboardText(value, out lastError))
        {
            statusLabel.Text = LFormat("copiedItem", label);
            AppendLog("[JK] Copied " + label + " to clipboard.");
            return true;
        }

        ShowFromTray();
        statusLabel.Text = LFormat("copyFailedManual", label);
        fallbackBox.UseSystemPasswordChar = false;
        fallbackBox.Text = value;
        fallbackBox.Focus();
        fallbackBox.SelectAll();
        AppendLog("[JK] Clipboard copy failed for " + label + ". Select the field manually: " + lastError.Message);
        return false;
    }

    private static bool TrySetClipboardText(string value, out Exception lastError)
    {
        lastError = null;
        for (var attempt = 0; attempt < 6; attempt++)
        {
            try
            {
                Clipboard.Clear();
                Clipboard.SetText(value, TextDataFormat.UnicodeText);
                return true;
            }
            catch (Exception ex)
            {
                lastError = ex;
                Application.DoEvents();
                System.Threading.Thread.Sleep(80 + attempt * 70);
            }
        }

        try
        {
            Clipboard.SetDataObject(value, true, 10, 150);
            return true;
        }
        catch (Exception ex)
        {
            lastError = ex;
            return false;
        }
    }

    private void AutoGenerateOwnerToken()
    {
        if (exitRequested || autoGenerateOwnerTokenOnNextStart) return;

        autoGenerateOwnerTokenOnNextStart = true;
        ownerToken = null;
        ownerTokenBox.UseSystemPasswordChar = false;
        ownerTokenBox.Text = L("ownerTokenGenerating");
        copyOwnerTokenButton.Enabled = false;
        autoGenerateOwnerTokenButton.Enabled = false;
        AppendLog("[JK] Auto-generating owner token and restarting runtime...");
        StopProcessTree();

        var timer = new Timer();
        timer.Interval = 1200;
        timer.Tick += delegate
        {
            timer.Stop();
            timer.Dispose();
            stopping = false;
            stopButton.Enabled = true;
            autoGenerateOwnerTokenButton.Enabled = true;
            StartLauncher();
        };
        timer.Start();
    }

    private void SetOwnerToken(string value)
    {
        ownerToken = value;
        autoGenerateOwnerTokenOnNextStart = false;
        ownerTokenBox.UseSystemPasswordChar = true;
        ownerTokenBox.Text = value;
        copyOwnerTokenButton.Enabled = true;
        autoGenerateOwnerTokenButton.Enabled = true;
        if (CopyTextToClipboard(ownerToken, L("ownerTokenLabel"), ownerTokenBox))
        {
            statusLabel.Text = L("ownerTokenReadyCopied");
        }
        else
        {
            statusLabel.Text = L("ownerTokenReadyManualCopy");
        }
        RefreshTrayState();
    }

    internal void ShowFromTray()
    {
        if (IsDisposed) return;
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void HideToTray()
    {
        if (exitRequested || IsDisposed) return;
        Hide();
        ShowInTaskbar = false;
        if (!trayNoticeShown)
        {
            trayNoticeShown = true;
            trayIcon.ShowBalloonTip(
                2500,
                "JK is still running",
                "Use the tray icon's Quit menu to stop the server and tunnel completely.",
                ToolTipIcon.Info);
        }
    }

    private void ExitApplication()
    {
        if (exitRequested) return;
        exitRequested = true;
        trayIcon.Visible = false;
        StopProcessTree();
        Close();
    }

    private void OnFormClosing(object sender, FormClosingEventArgs e)
    {
        if (!exitRequested && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }

        exitRequested = true;
        trayIcon.Visible = false;
        StopProcessTree();
    }

    private void StartLauncher()
    {
        stopping = false;
        if (IsPublicTunnelEnabledForLaunch() && !string.IsNullOrWhiteSpace(configuredPublicHost))
        {
            mcpUrl = "https://" + configuredPublicHost + "/mcp";
            urlBox.Text = mcpUrl;
            copyButton.Enabled = true;
        }
        else if (IsPublicTunnelEnabledForLaunch())
        {
            mcpUrl = null;
            urlBox.Text = "Waiting for Cloudflare connector URL...";
            copyButton.Enabled = false;
        }
        var script = Path.Combine(root, "start-jk.ps1");
        if (!File.Exists(script))
        {
            AppendLog("ERROR: start-jk.ps1 was not found next to JK.exe.");
            statusLabel.Text = "Missing launcher script";
            return;
        }

        AppendLog("JK launcher");
        AppendLog("Runtime: " + root);
        AppendLog("Log: " + logFile);
        AppendLog("");

        try
        {
            Directory.CreateDirectory(string.IsNullOrEmpty(selectedProjectPath) ? defaultWorkspace : selectedProjectPath);
        }
        catch (Exception ex)
        {
            AppendLog("ERROR: could not prepare workspace folder: " + ex.Message);
            statusLabel.Text = "Workspace folder error";
            RefreshTrayState();
            return;
        }

        var powerShellArgs = "-NoProfile -ExecutionPolicy Bypass -File " + Quote(script);
        var launcherArgs = new List<string>(BuildLauncherArgs());
        if (autoGenerateOwnerTokenOnNextStart)
        {
            launcherArgs.Add("-RotateOwnerToken");
        }
        if (launcherArgs.Count > 0) powerShellArgs += " " + JoinArgs(launcherArgs.ToArray());

        process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = powerShellArgs,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        if (autoGenerateOwnerTokenOnNextStart)
        {
            process.StartInfo.EnvironmentVariables["JK_ROTATE_OWNER_TOKEN"] = "1";
        }
        if (!string.IsNullOrEmpty(selectedProjectPath) && HasProjectMarker(selectedProjectPath))
        {
            process.StartInfo.EnvironmentVariables["JK_ACTIVE_PROJECT_ROOT"] = selectedProjectPath;
            process.StartInfo.EnvironmentVariables["JK_ACTIVE_PROJECT_PRESET"] = "full-write";
        }
        process.EnableRaisingEvents = true;
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data != null) AppendLog(e.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data != null) AppendLog(e.Data);
        };
        process.Exited += delegate(object sender, EventArgs e)
        {
            var exitedProcess = (Process)sender;
            var exitCode = exitedProcess.ExitCode;
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((Action)delegate
                {
                    statusLabel.Text = exitCode == 0 || stopping ? "Stopped" : "Exited with code " + exitCode;
                    RefreshTrayState();
                    AppendLog("");
                    AppendLog("JK exited with code " + exitCode + ".");
                });
            }
            catch (InvalidOperationException)
            {
                // The form is already closing.
            }
        };

        try
        {
            process.Start();
            autoGenerateOwnerTokenOnNextStart = false;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            statusLabel.Text = "Starting server and tunnel...";
            RefreshTrayState();
        }
        catch (Exception ex)
        {
            AppendLog("ERROR: " + ex.Message);
            statusLabel.Text = "Failed to start";
            RefreshTrayState();
        }
    }

    private void AppendLog(string line)
    {
        if (InvokeRequired)
        {
            BeginInvoke((Action)(() => AppendLog(line)));
            return;
        }

        line = CaptureSecretsForUiAndRedact(line);
        TrimCurrentLogIfNeeded();
        File.AppendAllText(logFile, line + Environment.NewLine, Encoding.UTF8);
        logBox.AppendText(line + Environment.NewLine);
        TrimVisibleLogIfNeeded();

        var match = Regex.Match(line, @"https?://\S+/mcp");
        if (match.Success)
        {
            var previousConnectorUrl = lastConnectorUrl;
            var detectedMcpUrl = match.Value.Trim();
            mcpUrl = IsPublicTunnelEnabledForLaunch() && !string.IsNullOrWhiteSpace(configuredPublicHost)
                ? "https://" + configuredPublicHost + "/mcp"
                : detectedMcpUrl;
            urlBox.Text = mcpUrl;
            copyButton.Enabled = true;
            if (!string.Equals(previousConnectorUrl, mcpUrl, StringComparison.OrdinalIgnoreCase))
            {
                lastConnectorUrl = mcpUrl;
                SaveSettings();
            }
            RefreshTrayState();
        }
        else if (line.IndexOf("JK is ready", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            statusLabel.Text = string.IsNullOrEmpty(mcpUrl) ? "Connected" : "Connected: " + mcpUrl;
        }
        else if (line.IndexOf("Waiting for ChatGPT connection", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            statusLabel.Text = "Waiting for ChatGPT connection";
        }
        else if (line.IndexOf("MCP endpoint available", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            statusLabel.Text = "MCP endpoint available; waiting for ChatGPT connection";
        }
        else if (line.IndexOf("JK runtime is running", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            statusLabel.Text = "JK runtime is running";
        }
        else if (line.IndexOf("public tunnel did not become ready", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            statusLabel.Text = string.IsNullOrEmpty(mcpUrl)
                ? "Local server is running; waiting for public tunnel"
                : "MCP URL ready; public tunnel is still warming up";
        }
    }

    private string CaptureSecretsForUiAndRedact(string line)
    {
        if (line.IndexOf("generated a new HTTP owner token", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            pendingSecretKind = "owner";
            return line;
        }
        if (line.IndexOf("owner token already set", StringComparison.OrdinalIgnoreCase) >= 0 &&
            string.IsNullOrEmpty(ownerToken))
        {
            ownerTokenBox.UseSystemPasswordChar = false;
            ownerTokenBox.Text = L("ownerTokenConfigured");
            autoGenerateOwnerTokenButton.Enabled = true;
            RefreshTrayState();
            return line;
        }

        var secretMatch = Regex.Match(line, @"^\s{2}([A-Za-z0-9_-]{40,})\s*$");
        if (secretMatch.Success && !string.IsNullOrEmpty(pendingSecretKind))
        {
            var value = secretMatch.Groups[1].Value;
            var kind = pendingSecretKind;
            pendingSecretKind = null;
            if (kind == "owner")
            {
                SetOwnerToken(value);
                return "  [owner token captured by app; copied to clipboard]";
            }
        }

        return line;
    }

    private void StopProcessTree()
    {
        if (stopping) return;
        stopping = true;
        RefreshTrayState();

        try
        {
            if (process != null && !process.HasExited)
            {
                AppendLog("");
                AppendLog("Stopping JK...");
                var killer = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill.exe",
                    Arguments = "/pid " + process.Id + " /t /f",
                    CreateNoWindow = true,
                    UseShellExecute = false
                });
                if (killer != null) killer.WaitForExit(5000);
            }
        }
        catch
        {
            // Best-effort shutdown only.
        }
        RefreshTrayState();
    }
}
