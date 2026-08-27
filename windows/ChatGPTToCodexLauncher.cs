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

internal static class ChatGPTToCodexLauncher
{
    [STAThread]
    private static void Main(string[] args)
    {
        bool createdNew;
        using (var singleInstance = new System.Threading.Mutex(true, @"Local\JK.ChatGPTToCodexLauncher", out createdNew))
        {
            if (!createdNew) return;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm(args));
        }
    }
}

internal sealed class LauncherForm : Form
{
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
    private Timer approvalPollTimer;
    private string consoleProjectId;
    private JkRoleContext cachedRoleContext;
    private bool autoGenerateOwnerTokenOnNextStart;

    internal LauncherForm(string[] args)
    {
        this.args = args;
        disableTunnelForLaunch = Array.Exists(args, value => IsOption(value, "-NoTunnel"));
        root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        appDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JK");
        logDir = Path.Combine(appDataDir, "logs");
        selectedProjectFile = Path.Combine(appDataDir, "selected-project.txt");
        settingsFile = Path.Combine(appDataDir, "settings.ini");
        defaultWorkspace = ResolveDefaultWorkspace();
        configuredPublicHost = ResolveConfiguredPublicHost();
        port = ResolvePort();
        publicTunnelEnabled = false;
        githubRepoUrl = Environment.GetEnvironmentVariable("CHATGPT2CODEX_UPDATE_REPO_URL");
        if (string.IsNullOrWhiteSpace(githubRepoUrl)) githubRepoUrl = "https://github.com/Anjingyeong/jk-mcp";
        LoadSettings();
        if (string.IsNullOrEmpty(selectedProjectPath)) selectedProjectPath = LoadSelectedProjectPath();
        if (MigrateLegacyExecutorStartupIntent())
        {
            launchAtStartup = true;
            startMcpOnOpen = true;
            SaveSettings();
        }
        Directory.CreateDirectory(logDir);
        PruneLauncherLogs(logDir);
        logFile = Path.Combine(logDir, "launcher-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");

        Text = "JK";
        Width = 1060;
        Height = 680;
        MinimumSize = new System.Drawing.Size(900, 620);
        StartPosition = FormStartPosition.CenterScreen;
        SetWindowIcon(this);

        statusLabel = new Label();
        statusLabel.Text = "JK: " + L("statusChecking");
        statusLabel.Dock = DockStyle.Top;
        statusLabel.Height = 34;
        statusLabel.Padding = new Padding(10, 8, 10, 0);

        logBox = new TextBox();
        logBox.Dock = DockStyle.Fill;
        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Both;
        logBox.WordWrap = false;
        logBox.Font = new System.Drawing.Font("Consolas", 10);

        var bottomPanel = new TableLayoutPanel();
        bottomPanel.Dock = DockStyle.Bottom;
        bottomPanel.Height = 86;
        bottomPanel.ColumnCount = 1;
        bottomPanel.RowCount = 2;
        bottomPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        bottomPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));

        var urlPanel = new FlowLayoutPanel();
        urlPanel.Dock = DockStyle.Fill;
        urlPanel.Padding = new Padding(8, 7, 8, 0);
        urlPanel.FlowDirection = FlowDirection.LeftToRight;
        urlPanel.WrapContents = false;

        urlBox = new TextBox();
        urlBox.Width = 390;
        urlBox.ReadOnly = true;
        urlBox.Text = "Connector URL will appear here";

        copyButton = new Button();
        copyButton.Text = L("copyConnector");
        copyButton.Width = 130;
        copyButton.Enabled = false;
        copyButton.Click += delegate { CopyMcpUrl(); };

        var openDashboardButton = new Button();
        openDashboardButton.Text = "Cloud Dashboard";
        openDashboardButton.Width = 130;
        openDashboardButton.Click += delegate { OpenUrl(PublicControlCenterUrl()); };

        var tokenPanel = new FlowLayoutPanel();
        tokenPanel.Dock = DockStyle.Fill;
        tokenPanel.Padding = new Padding(8, 1, 8, 7);
        tokenPanel.FlowDirection = FlowDirection.LeftToRight;
        tokenPanel.WrapContents = false;

        ownerTokenBox = new TextBox();
        ownerTokenBox.Width = 520;
        ownerTokenBox.ReadOnly = true;
        ownerTokenBox.Text = "Owner token will be auto-generated and copied on first setup";

        copyOwnerTokenButton = new Button();
        copyOwnerTokenButton.Text = L("copyOwnerToken");
        copyOwnerTokenButton.Width = 130;
        copyOwnerTokenButton.Enabled = false;
        copyOwnerTokenButton.Click += delegate { CopyOwnerToken(); };

        autoGenerateOwnerTokenButton = new Button();
        autoGenerateOwnerTokenButton.Text = L("autoGenerateToken");
        autoGenerateOwnerTokenButton.Width = 150;
        autoGenerateOwnerTokenButton.Click += delegate { AutoGenerateOwnerToken(); };

        openLogButton = new Button();
        openLogButton.Text = L("showLogs");
        openLogButton.Width = 80;
        openLogButton.Click += delegate { ShowLogs(); };

        stopButton = new Button();
        stopButton.Text = L("stopMCP");
        stopButton.Width = 90;
        stopButton.Click += delegate { ToggleServer(); };

        urlPanel.Controls.Add(urlBox);
        urlPanel.Controls.Add(copyButton);
        urlPanel.Controls.Add(openDashboardButton);
        urlPanel.Controls.Add(openLogButton);
        urlPanel.Controls.Add(stopButton);

        tokenPanel.Controls.Add(ownerTokenBox);
        tokenPanel.Controls.Add(copyOwnerTokenButton);
        tokenPanel.Controls.Add(autoGenerateOwnerTokenButton);

        bottomPanel.Controls.Add(urlPanel, 0, 0);
        bottomPanel.Controls.Add(tokenPanel, 0, 1);

        var summaryPanel = new TableLayoutPanel();
        summaryPanel.Dock = DockStyle.Top;
        summaryPanel.Height = 88;
        summaryPanel.ColumnCount = 4;
        summaryPanel.RowCount = 2;
        summaryPanel.Padding = new Padding(10, 6, 10, 4);
        summaryPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        summaryPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        summaryPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        summaryPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        summaryPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        summaryPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));

        summaryPanel.Controls.Add(NewSummaryTitle("PROJECT"), 0, 0);
        summaryPanel.Controls.Add(NewSummaryTitle("ROLE"), 1, 0);
        summaryPanel.Controls.Add(NewSummaryTitle("MODE"), 2, 0);
        summaryPanel.Controls.Add(NewSummaryTitle("SKILLS"), 3, 0);
        dashboardProjectValue = NewSummaryValue("—");
        dashboardRoleValue = NewSummaryValue("Default");
        dashboardModeValue = NewSummaryValue("—");
        dashboardSkillsValue = NewSummaryValue("—");
        summaryPanel.Controls.Add(dashboardProjectValue, 0, 1);
        summaryPanel.Controls.Add(dashboardRoleValue, 1, 1);
        summaryPanel.Controls.Add(dashboardModeValue, 2, 1);
        summaryPanel.Controls.Add(dashboardSkillsValue, 3, 1);

        dashboardPanel = new Panel();
        dashboardPanel.Dock = DockStyle.Fill;
        dashboardPanel.BackColor = System.Drawing.Color.White;
        dashboardPanel.Controls.Add(logBox);
        dashboardPanel.Controls.Add(bottomPanel);
        dashboardPanel.Controls.Add(summaryPanel);
        dashboardPanel.Controls.Add(statusLabel);

        contentHost = new Panel();
        contentHost.Dock = DockStyle.Fill;
        contentHost.BackColor = System.Drawing.Color.White;
        contentHost.Controls.Add(dashboardPanel);

        var sidebar = new Panel();
        sidebar.Dock = DockStyle.Left;
        sidebar.Width = 174;
        sidebar.BackColor = System.Drawing.Color.FromArgb(245, 246, 248);

        var brand = new Label();
        brand.Text = "JK";
        brand.Font = new System.Drawing.Font("Segoe UI", 22, System.Drawing.FontStyle.Bold);
        brand.SetBounds(22, 18, 120, 44);
        sidebar.Controls.Add(brand);

        var dashboardNav = NewNavigationButton("Launcher", 82);
        dashboardNav.Click += delegate { ShowDashboardPage(); };
        sidebar.Controls.Add(dashboardNav);
        var controlCenterNav = NewNavigationButton("Dashboard", 126);
        controlCenterNav.Click += delegate { OpenUrl(PublicControlCenterUrl()); };
        sidebar.Controls.Add(controlCenterNav);
        var updatesNav = NewNavigationButton("Updates", 170);
        updatesNav.Click += delegate { CheckUpdates(true); };
        sidebar.Controls.Add(updatesNav);
        var settingsNav = NewNavigationButton("Settings", 214);
        settingsNav.Click += delegate { ShowSettings(); };
        sidebar.Controls.Add(settingsNav);

        Controls.Add(contentHost);
        Controls.Add(sidebar);

        trayMenu = new ContextMenuStrip();
        statusTrayItem = new ToolStripMenuItem("JK: " + L("statusChecking"));
        statusTrayItem.Enabled = false;
        var controlCenterTrayItem = new ToolStripMenuItem("Open Cloud Control Center", null, delegate { OpenUrl(PublicControlCenterUrl()); });
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
                    if (RoleApiAvailable() || roleSummaryAttempts >= 5)
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
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("WORKSPACE");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("CHATGPT2CODEX_WORKSPACE");
        if (string.IsNullOrWhiteSpace(value))
        {
            value = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "workspace");
        }
        return Path.GetFullPath(value);
    }

    private int ResolvePort()
    {
        var value = GetArgValue("-Port");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("PORT");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("CHATGPT2CODEX_PORT");
        int parsed;
        return int.TryParse(value, out parsed) && parsed > 0 ? parsed : 7979;
    }

    private string ResolveConfiguredPublicHost()
    {
        var value = GetArgValue("-PublicHostname");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("PUBLIC_HOSTNAME");
        if (string.IsNullOrWhiteSpace(value)) value = Environment.GetEnvironmentVariable("CHATGPT2CODEX_PUBLIC_HOSTNAME");
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
                else if (key == "PublicHostname") configuredPublicHost = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
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

        if (Environment.GetEnvironmentVariable("CHATGPT2CODEX_EXPOSE_WEB") == "1" ||
            !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("PUBLIC_HOSTNAME")) ||
            !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CHATGPT2CODEX_PUBLIC_HOSTNAME")))
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
        if (!string.IsNullOrEmpty(mcpUrl)) return mcpUrl;
        if (IsPublicTunnelEnabledForLaunch() && !string.IsNullOrEmpty(configuredPublicHost)) return "https://" + configuredPublicHost + "/mcp";
        if (IsPublicTunnelEnabledForLaunch()) return null;
        return "http://127.0.0.1:" + port + "/mcp";
    }

    private string DisplayConnectorUrl()
    {
        var hub = Environment.GetEnvironmentVariable("JK_HUB_URL") ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(hub))
        {
            var normalized = hub.Trim().TrimEnd('/');
            return normalized.EndsWith("/mcp", StringComparison.OrdinalIgnoreCase) ? normalized : normalized + "/mcp";
        }
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
        var hub = Environment.GetEnvironmentVariable("JK_HUB_URL") ?? string.Empty;
        Uri parsed;
        if (!string.IsNullOrWhiteSpace(hub) && Uri.TryCreate(hub, UriKind.Absolute, out parsed))
        {
            return parsed.GetLeftPart(UriPartial.Authority) + "/";
        }
        return LocalControlCenterUrl();
    }

    private string LocalControlCenterUrl()
    {
        return "http://127.0.0.1:" + port + "/";
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
        var hub = Environment.GetEnvironmentVariable("JK_HUB_URL") ?? string.Empty;
        Uri parsed;
        if (!string.IsNullOrWhiteSpace(hub) && Uri.TryCreate(hub, UriKind.Absolute, out parsed))
        {
            return PublicApprovalsPageUrl();
        }
        return LocalApprovalsPageUrl();
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
            return;
        }

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
                OpenUrl(PublicControlCenterUrl());
                AppendLog("[chatgpt2codex] Opened remote Control Center in the default browser.");
                return;
            }

            if (exitRequested || attempts >= 40)
            {
                timer.Stop();
                timer.Dispose();
                if (!exitRequested)
                {
                    AppendLog("[chatgpt2codex] Control Center did not become ready within 20 seconds; browser was not opened.");
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
        try
        {
            var repo = (githubRepoUrl ?? string.Empty).TrimEnd('/');
            var match = Regex.Match(repo, @"github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)", RegexOptions.IgnoreCase);
            if (!match.Success)
            {
                if (manual) OpenUrl(repo);
                return;
            }

            var api = "https://api.github.com/repos/" + match.Groups["owner"].Value + "/" + match.Groups["repo"].Value + "/releases/latest";
            using (var client = new WebClient())
            {
                client.Headers.Add("User-Agent", "chatgpt2codex");
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

                var message = latest == installed
                    ? "JK is up to date (" + installed + ")."
                    : "Update available: " + latest + ". Installed: " + installed + ".";
                if (manual) MessageBox.Show(this, message, "JK", MessageBoxButtons.OK, MessageBoxIcon.Information);
                else statusLabel.Text = message;
            }
        }
        catch
        {
            if (manual && MessageBox.Show(this, "Could not check releases automatically. Open releases page?", "JK", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
            {
                OpenUrl((githubRepoUrl ?? string.Empty).TrimEnd('/') + "/releases");
            }
        }
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
        var markers = new[] { ".git", "package.json", "pubspec.yaml", "go.mod", "Cargo.toml", "requirements.txt", ".chatgpt2codex" };
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
            AppendLog("[chatgpt2codex] Selected project folder: " + selectedProjectPath);
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
        button.SetBounds(x, y, width, 30);
        return button;
    }

    private static Label NewSummaryTitle(string text)
    {
        var label = new Label();
        label.Text = text;
        label.Dock = DockStyle.Fill;
        label.Padding = new Padding(4, 3, 4, 0);
        label.Font = new System.Drawing.Font("Segoe UI", 8, System.Drawing.FontStyle.Bold);
        label.ForeColor = System.Drawing.SystemColors.GrayText;
        return label;
    }

    private static Label NewSummaryValue(string text)
    {
        var label = new Label();
        label.Text = text;
        label.Dock = DockStyle.Fill;
        label.Padding = new Padding(4, 2, 4, 0);
        label.Font = new System.Drawing.Font("Segoe UI", 10, System.Drawing.FontStyle.Bold);
        label.AutoEllipsis = true;
        return label;
    }

    private static Button NewNavigationButton(string text, int top)
    {
        var button = new Button();
        button.Text = text;
        button.SetBounds(12, top, 150, 38);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
        button.Padding = new Padding(12, 0, 0, 0);
        button.BackColor = System.Drawing.Color.FromArgb(245, 246, 248);
        return button;
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
        var existing = contentHost.Controls.Cast<Control>().ToArray();
        foreach (var control in existing)
        {
            contentHost.Controls.Remove(control);
            if (!object.ReferenceEquals(control, dashboardPanel)) control.Dispose();
        }
        page.Dock = DockStyle.Fill;
        contentHost.Controls.Add(page);
        page.BringToFront();
    }

    private void RefreshDashboardRoleSummary()
    {
        dashboardProjectValue.Text = !string.IsNullOrWhiteSpace(selectedProjectPath)
            ? Path.GetFileName(selectedProjectPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
            : "—";
        dashboardRoleValue.Text = "Default";
        dashboardModeValue.Text = "—";
        dashboardSkillsValue.Text = "—";

        if (!RoleApiAvailable()) return;
        try
        {
            RefreshRoleData(consoleProjectId);
            if (cachedRoleContext == null) return;
            dashboardProjectValue.Text = string.IsNullOrWhiteSpace(cachedRoleContext.projectName) ? "—" : cachedRoleContext.projectName;
            dashboardRoleValue.Text = cachedRoleContext.role == null ? "Default" : cachedRoleContext.role.name;
            dashboardModeValue.Text = PermissionLabel(cachedRoleContext.effectivePermission);
            dashboardSkillsValue.Text = cachedRoleContext.role != null && cachedRoleContext.role.skills != null && cachedRoleContext.role.skills.Length > 0
                ? string.Join(" · ", cachedRoleContext.role.skills)
                : "—";
        }
        catch
        {
            // Dashboard remains usable even if the local role API is temporarily unavailable.
        }
    }

    private void ShowDashboardPage()
    {
        ShowConsolePage(dashboardPanel);
        RefreshDashboardRoleSummary();
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
                    "JK\r\nLocal coding bridge for ChatGPT\r\n\r\nBased on ChatGPT To Codex by ezBuilder.\r\nOriginal work © 2026 ezBuilder. All rights reserved.",
                    "About JK",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            };
            form.Controls.Add(about);

            var copyright = NewLabel("Original work © 2026 ezBuilder. All rights reserved.", 24, 560, 420);
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
            publicTunnelEnabled = tunnelCheck.Checked;
            configuredPublicHost = string.IsNullOrWhiteSpace(hostBox.Text) ? null : hostBox.Text.Trim();
            port = (int)portBox.Value;
            githubRepoUrl = string.IsNullOrWhiteSpace(repoBox.Text) ? "https://github.com/ezBuilder/chatgpt2codex" : repoBox.Text.Trim();
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
        restartTrayItem.Enabled = true;
        restartTrayItem.Text = L("restartMCP");
        var connector = DisplayConnectorUrl();
        if (!string.IsNullOrEmpty(connector) && (string.IsNullOrEmpty(urlBox.Text) || urlBox.Text == "Connector URL will appear here"))
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
        AppendLog("[chatgpt2codex] Restarting MCP runtime...");
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
            trimmed[0] = "[chatgpt2codex] Older log output trimmed to keep this file bounded.";
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
            AppendLog("[chatgpt2codex] Copied " + label + " to clipboard.");
            return true;
        }

        ShowFromTray();
        statusLabel.Text = LFormat("copyFailedManual", label);
        fallbackBox.UseSystemPasswordChar = false;
        fallbackBox.Text = value;
        fallbackBox.Focus();
        fallbackBox.SelectAll();
        AppendLog("[chatgpt2codex] Clipboard copy failed for " + label + ". Select the field manually: " + lastError.Message);
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
        AppendLog("[chatgpt2codex] Auto-generating owner token and restarting runtime...");
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

    private void ShowFromTray()
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
        if (IsPublicTunnelEnabledForLaunch() && string.IsNullOrWhiteSpace(configuredPublicHost))
        {
            mcpUrl = null;
            urlBox.Text = "Waiting for Cloudflare connector URL...";
            copyButton.Enabled = false;
        }
        var script = Path.Combine(root, "start-chatgpt.ps1");
        if (!File.Exists(script))
        {
            AppendLog("ERROR: start-chatgpt.ps1 was not found next to JK.exe.");
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
            process.StartInfo.EnvironmentVariables["CHATGPT2CODEX_ROTATE_OWNER_TOKEN"] = "1";
        }
        if (!string.IsNullOrEmpty(selectedProjectPath) && HasProjectMarker(selectedProjectPath))
        {
            process.StartInfo.EnvironmentVariables["CHATGPT2CODEX_ACTIVE_PROJECT_ROOT"] = selectedProjectPath;
            process.StartInfo.EnvironmentVariables["CHATGPT2CODEX_ACTIVE_PROJECT_PRESET"] = "full-write";
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
                    AppendLog("chatgpt2codex exited with code " + exitCode + ".");
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
            mcpUrl = match.Value.Trim();
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
