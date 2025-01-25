/*
    Main processing handler for popup.html

*/
var main = (function () {
    "use strict";

    // this will be called when message listener fires
    async function onMessageListener(message, sender, sendResponse) {  // eslint-disable-line no-unused-vars
        if (message.messageType == "ParseResults") {
            chrome.runtime.onMessage.removeListener(onMessageListener);
            util.log("addListener");
            util.log(message);
            // convert the string returned from content script back into a DOM
            let dom = new DOMParser().parseFromString(message.document, "text/html");
            await populateControlsWithDom(message.url, dom);
        }
    };

    // details 
    let initalWebPage = null;
    let parser = null;
    let userPreferences = null;
    let library = new Library; 

    // register listener that is invoked when script injected into HTML sends its results
    function addMessageListener() {
        try {
            // note, this will throw if not running as an extension.
            if (!chrome.runtime.onMessage.hasListener(onMessageListener)) {
                chrome.runtime.onMessage.addListener(onMessageListener);
            }
        } catch (chromeError) {
            util.log(chromeError);
        }
    }

    // extract urls from DOM and populate control
    async function processInitialHtml(url, dom) {
        if (setParser(url, dom)) {
            try {
                userPreferences.addObserver(parser);
                let metaInfo = parser.getEpubMetaInfo(dom, userPreferences.useFullTitle.value);
                populateMetaInfo(metaInfo);
                setUiToDefaultState();
                parser.populateUI(dom);
                await parser.onLoadFirstPage(url, dom).then( () => {
                    console.log("trying to load from processInitialHtml")
                    fetchContentAndPackEpub()
                });
            } catch (error) {
                ErrorLog.showErrorMessage(error);
            }
        }
    }

    function setUiToDefaultState() {
        document.getElementById("higestResolutionImagesRow").hidden = true; 
        document.getElementById("unSuperScriptAlternateTranslations").hidden = true; 
        document.getElementById("imageSection").hidden = true;
        document.getElementById("outputSection").hidden = false;
        document.getElementById("translatorRow").hidden = true;
        document.getElementById("fileAuthorAsRow").hidden = true;
        document.getElementById("defaultParserSection").hidden = true;
    }

    function populateMetaInfo(metaInfo) {
        setUiFieldToValue("startingUrlInput", metaInfo.uuid);
        setUiFieldToValue("titleInput", metaInfo.title);
        setUiFieldToValue("authorInput", metaInfo.author);
        setUiFieldToValue("languageInput", metaInfo.language);
        setUiFieldToValue("fileNameInput", metaInfo.fileName);
        setUiFieldToValue("subjectInput", metaInfo.subject);
        setUiFieldToValue("descriptionInput", metaInfo.description);
        if (metaInfo.seriesName !== null) {
            document.getElementById("seriesRow").hidden = false;
            document.getElementById("volumeRow").hidden = false;
            setUiFieldToValue("seriesNameInput", metaInfo.seriesName);
            setUiFieldToValue("seriesIndexInput", metaInfo.seriesIndex);
        }

        setUiFieldToValue("translatorInput", metaInfo.translator);
        setUiFieldToValue("fileAuthorAsInput", metaInfo.fileAuthorAs);
    }

    function setUiFieldToValue(elementId, value) {
        let element = document.getElementById(elementId);
        if (util.isTextInputField(element) || util.isTextAreaField(element)) {
            element.value = (value == null) ? "" : value;
        } else {
            throw new Error(chrome.i18n.getMessage("unhandledFieldTypeError"));
        }
    }

    function metaInfoFromControls() {
        let metaInfo = new EpubMetaInfo();
        metaInfo.uuid = getValueFromUiField("startingUrlInput");
        metaInfo.title = getValueFromUiField("titleInput");
        metaInfo.author = getValueFromUiField("authorInput");
        metaInfo.language = getValueFromUiField("languageInput");
        let fileId = new URLSearchParams(window.location.search).get('saveAs');
        metaInfo.fileName = !fileId || fileId.length === 0? getValueFromUiField("fileNameInput") : decodeURIComponent(fileId);
        metaInfo.subject = getValueFromUiField("subjectInput");
        metaInfo.description = getValueFromUiField("descriptionInput");

        if (document.getElementById("seriesRow").hidden === false) {
            metaInfo.seriesName = getValueFromUiField("seriesNameInput");
            metaInfo.seriesIndex = getValueFromUiField("seriesIndexInput");
        }

        metaInfo.translator = getValueFromUiField("translatorInput");
        metaInfo.fileAuthorAs = getValueFromUiField("fileAuthorAsInput");
        metaInfo.styleSheet = userPreferences.styleSheet.value;

        return metaInfo;
    }

    function getValueFromUiField(elementId) {
        let element = document.getElementById(elementId);
        if (util.isTextInputField(element) || util.isTextAreaField(element)) {
            return (element.value === "") ? null : element.value;
        } else {
            throw new Error(chrome.i18n.getMessage("unhandledFieldTypeError"));
        }
    }

    function fetchContentAndPackEpub() {
        console.log("starting fetch and pack")
        let libclick = this;
        if (document.getElementById("noAdditionalMetadataCheckbox").checked == true) {
            setUiFieldToValue("subjectInput", "");
            setUiFieldToValue("descriptionInput", "");
        }
        let metaInfo = metaInfoFromControls();
        let fileName = EpubPacker.addExtensionIfMissing(metaInfo.fileName);

        if (Download.isFileNameIllegalOnWindows(fileName)) {
            ErrorLog.showErrorMessage(chrome.i18n.getMessage("errorIllegalFileName",
                [fileName, Download.illegalWindowsFileNameChars]
            ));
            return;
        }

        if (libclick && "yes" == libclick.dataset.libclick) {
            if (document.getElementById("chaptersPageInChapterListCheckbox").checked) {
                ErrorLog.showErrorMessage(chrome.i18n.getMessage("errorAddToLibraryLibraryAddPageWithChapters"));
                return;
            }
        }
        console.log("from user pref - max chapters: " + userPreferences.maxChaptersPerEpub.value)
        ChapterUrlsUI.limitNumOfChapterS(userPreferences.maxChaptersPerEpub.value);
        ChapterUrlsUI.resetDownloadStateImages();
        ErrorLog.clearHistory();
        window.workInProgress = true;
        main.getPackEpubButton().disabled = true;
        document.getElementById("LibAddToLibrary").disabled = true;
        parser.onStartCollecting();
        parser.fetchContent().then(function () {
            return packEpub(metaInfo);
        }).then(function (content) {
            // Enable button here.  If user cancels save dialog
            // the promise never returns
            window.workInProgress = false;
            main.getPackEpubButton().disabled = false;
            document.getElementById("LibAddToLibrary").disabled = false;
            let overwriteExisting = true;
            let backgroundDownload = true;
            if (libclick && "yes" == libclick.dataset.libclick) {
                return library.LibAddToLibrary(content, fileName, overwriteExisting, backgroundDownload);
            }
            return Download.save(content, fileName, overwriteExisting, backgroundDownload);
        }).then(function () {
            parser.updateReadingList();
            ErrorLog.showLogToUser();
            return dumpErrorLogToFile();
        }).catch(function (err) {
            window.workInProgress = false;
            main.getPackEpubButton().disabled = false;
            document.getElementById("LibAddToLibrary").disabled = false;
            ErrorLog.showErrorMessage(err);
        });
    }

    function epubVersionFromPreferences() {
        return userPreferences.createEpub3.value ? 
            EpubPacker.EPUB_VERSION_3 : EpubPacker.EPUB_VERSION_2;
    }

    function packEpub(metaInfo) {
        let epubVersion = epubVersionFromPreferences();
        let epub = new EpubPacker(metaInfo, epubVersion);
        return epub.assemble(parser.epubItemSupplier());
    }

    function dumpErrorLogToFile() {
        let errors = ErrorLog.dumpHistory();
        if (userPreferences.writeErrorHistoryToFile.value &&
            !util.isNullOrEmpty(errors)) {
            let fileName = metaInfoFromControls().fileName + ".ErrorLog.txt";
            let blob = new Blob([errors], {type : "text"});
            return Download.save(blob, fileName)
                .catch (err => ErrorLog.showErrorMessage(err));
        }
    }

    function getActiveTabDOM(tabId) {
        addMessageListener();
        injectContentScript(tabId);
    }

    function injectContentScript(tabId) {
        if (util.isFirefox()) {
            Firefox.injectContentScript(tabId);
        } else {
            chromeInjectContentScript(tabId);
        }
    }

    function chromeInjectContentScript(tabId) {
        try {
            chrome.scripting.executeScript({
                target: {tabId: tabId},
                files: ["js/ContentScript.js"]
            });
        } catch {
            if (chrome.runtime.lastError) {
                util.log(chrome.runtime.lastError.message);
            };
        }
    }

    function populateControls() {
        loadUserPreferences();
        parserFactory.populateManualParserSelectionTag(getManuallySelectParserTag());
        configureForTabMode();
    }

    function loadUserPreferences() {
        userPreferences = UserPreferences.readFromLocalStorage();
        const params = new URLSearchParams(window.location.search);
        if (params.has("maxFetch")) {
            userPreferences.maxPagesToFetchSimultaneously.value = params.get("maxFetch");
        }
        if (params.has("skipImages")) {
            userPreferences.skipImages.value = (params.get("skipImages") == "true");
        }
        if (params.has("manualDelay")) {
            userPreferences.manualDelayPerChapter.value = params.get("manualDelay");
        }
        userPreferences.addObserver(library);
        userPreferences.writeToUi();
        userPreferences.hookupUi();
        BakaTsukiSeriesPageParser.registerBakaParsers(userPreferences.autoSelectBTSeriesPage.value);
    }

    function isRunningInTabMode() {
        // if query string supplied, we're running in Tab mode.
        let search = new URLSearchParams(window.location.search);
        return search.has('id');
    }

    async function populateControlsWithDom(url, dom) {
        console.log("populating controls with dom")
        initalWebPage = dom;
        setUiFieldToValue("startingUrlInput", url);

        // set the base tag, in case server did not supply it 
        util.setBaseTag(url, initalWebPage);
        await processInitialHtml(url, initalWebPage);
        if (document.getElementById("autosearchmetadataCheckbox").checked == true) {
            autosearchadditionalmetadata();
        }
    }

    function setParser(url, dom) {
        let manualSelect = getManuallySelectParserTag().value;
        if (util.isNullOrEmpty(manualSelect)) {
            parser = parserFactory.fetch(url, dom);
        } else {
            parser = parserFactory.manuallySelectParser(manualSelect);
        }
        if (parser === undefined) {
            ErrorLog.showErrorMessage(chrome.i18n.getMessage("noParserFound"));
            return false;
        }
        getLoadAndAnalyseButton().hidden = true;
        let disabledMessage = parser.disabled();
        if (disabledMessage !== null) {
            ErrorLog.showErrorMessage(disabledMessage);
            return false;
        }
        return true;
    }

    // called when the "Diagnostics" check box is ticked or unticked
    function onDiagnosticsClick() {
        let enable = document.getElementById("diagnosticsCheckBoxInput").checked;
        document.getElementById("reloadButton").hidden = !enable;
    }

    function onAdvancedOptionsClick() {
        let section =  getAdvancedOptionsSection();
        section.hidden = !section.hidden;
        section =  getLibrarySection();
        section.hidden = true;
    }

    function onLibraryClick(){
        let section =  getLibrarySection();
        section.hidden = !section.hidden;
        if (!section.hidden) {
            Library.LibRenderSavedEpubs();
        }
        section =  getAdvancedOptionsSection();
        section.hidden = true;
    }

    function onStylesheetToDefaultClick() {
        document.getElementById("stylesheetInput").value = EpubMetaInfo.getDefaultStyleSheet();
        userPreferences.readFromUi();
    }

    function openTabWindow() {
        // open new tab window, passing ID of open tab with content to convert to epub as query parameter.
        getActiveTab().then(function (tabId) {
            let url = chrome.runtime.getURL("popup.html") + "?id=";
            url += tabId;
            try {
                chrome.tabs.create({ url: url, openerTabId: tabId });
            }
            catch(err) {
                //firefox android catch
                chrome.tabs.create({ url: url});
            }
            window.close();
        });
    }

    function getActiveTab() {
        return new Promise(function (resolve, reject) {
            chrome.tabs.query({ currentWindow: true, active: true }, function (tabs) {
                if ((tabs != null) && (0 < tabs.length)) {
                    resolve(tabs[0].id);
                } else {
                    reject();
                };
            });
        });
    }

    async function onLoadAndAnalyseButtonClick() {
        // load page via XmlHTTPRequest
        let url = getValueFromUiField("startingUrlInput");
        getLoadAndAnalyseButton().disabled = true;
        return await HttpClient.wrapFetch(url).then(async function (xhr) {
            await populateControlsWithDom(url, xhr.responseXML);
            getLoadAndAnalyseButton().disabled = false;
        }).catch(function (error) {
            getLoadAndAnalyseButton().disabled = false;
            ErrorLog.showErrorMessage(error);
        });
    }

    function configureForTabMode() {
        console.log("getting tab id from query parameter")
        getActiveTabDOM(extractTabIdFromQueryParameter());
    }

    function extractTabIdFromQueryParameter() {
        let windowId = window.location.search.split("=")[1];
        if (!util.isNullOrEmpty(windowId)) {
            return parseInt(windowId, 10);
        }
    }

    function getPackEpubButton() {
        return document.getElementById("packEpubButton");
    }

    function getLoadAndAnalyseButton() {
        return document.getElementById("loadAndAnalyseButton");
    }

    function resetUI() {
        initalWebPage = null;
        parser = null;
        let metaInfo = new EpubMetaInfo();
        metaInfo.uuid = "";
        populateMetaInfo(metaInfo);
        getLoadAndAnalyseButton().hidden = false;
        main.getPackEpubButton().disabled = false;
        document.getElementById("LibAddToLibrary").disabled = false;
        ChapterUrlsUI.clearChapterUrlsTable();
        CoverImageUI.clearUI();
        ProgressBar.setValue(0);
    }

    function localize(element) {
        let localized = chrome.i18n.getMessage(element.textContent.trim());
        if (!util.isNullOrEmpty(localized)) {
            element.innerText = localized;
        };
    }

    function localizeHtmlPage()
    {
        // can't use a single select, because there are buttons in td elements
        for(let selector of ["button, option", "td, th", ".i18n"]) {
            for(let element of [...document.querySelectorAll(selector)]) {
                if (element.textContent.startsWith("__MSG_")) {
                    localize(element);
                }
            }
        }
    }

    function clearCoverUrl() {
        CoverImageUI.setCoverImageUrl(null);
    }

    function getManuallySelectParserTag() {
        return document.getElementById("manuallySelectParserTag");
    }

    function getAdvancedOptionsSection() {
        return document.getElementById("advancedOptionsSection");
    }

    function getLibrarySection() {
        return document.getElementById("hiddenBibSection");
    }

    function onSeriesPageHelp() {
        chrome.tabs.create({ url: "https://github.com/dteviot/WebToEpub/wiki/FAQ#using-baka-tsuki-series-page-parser" });
    }

    function onDefaultParserHelp() {
        chrome.tabs.create({ url: "https://github.com/dteviot/WebToEpub/wiki/FAQ#how-to-convert-a-new-site-using-the-default-parser" });
    }

    function onReadOptionsFromFile(event) {
        userPreferences.readFromFile(event, populateControls);
    }

    function onReadingListCheckboxClicked() {
        let url = parser.state.chapterListUrl;
        let checked = UserPreferences.getReadingListCheckbox().checked;
        userPreferences.readingList.onReadingListCheckboxClicked(checked, url);
    }

    function showReadingList() {
        let sections = new Map(
            [...document.querySelectorAll("section")]
                .map(s =>[s, s.hidden])
        );
        [...sections.keys()].forEach(s => s.hidden = true);

        document.getElementById("readingListSection").hidden = false;
        document.getElementById("closeReadingList").onclick = function () {
            [...sections].forEach(s => s[0].hidden = s[1])
        };

        let table = document.getElementById("readingListTable");
        userPreferences.readingList.showReadingList(table);
        table.onclick = (event) => userPreferences.readingList.onClickRemove(event);
    }

    /**
     * If work in progress, give user chance to cancel closing the window
     */
    function onUnloadEvent(event) {
        if (window.workInProgress === true) {
            event.preventDefault();
            event.returnValue = "";
        } else {
            delete event["returnValue"];
        }
    }

    async function addAutoPopulateFromParams() {
        let params = new URLSearchParams(window.location.search);
        if (params.has("url")) {
            console.log("auto populating from params")
            setUiFieldToValue("startingUrlInput", decodeURIComponent(params.get("url")));
            await onLoadAndAnalyseButtonClick();
        } else {
            console.log("no url in params")
        }
    }

    function addEventHandlers() {

        chrome.downloads.onCreated.addListener(
            (downloadItem) => {
                console.log("download created")
                console.log(downloadItem.url)
                })

        addAutoPopulateFromParams().then(r => console.log("auto populate done"));
        getPackEpubButton().onclick = fetchContentAndPackEpub;
        document.getElementById("diagnosticsCheckBoxInput").onclick = onDiagnosticsClick;
        document.getElementById("reloadButton").onclick = populateControls;
        getManuallySelectParserTag().onchange = populateControls;
        document.getElementById("advancedOptionsButton").onclick = onAdvancedOptionsClick;
        document.getElementById("hiddenBibButton").onclick = onLibraryClick;
        document.getElementById("LibShowAdvancedOptionsCheckbox").addEventListener("change", function(){Library.LibRenderSavedEpubs()});
        document.getElementById("LibAddToLibrary").addEventListener("click", fetchContentAndPackEpub);
        document.getElementById("stylesheetToDefaultButton").onclick = onStylesheetToDefaultClick;
        document.getElementById("resetButton").onclick = resetUI;
        document.getElementById("clearCoverImageUrlButton").onclick = clearCoverUrl;
        document.getElementById("seriesPageHelpButton").onclick = onSeriesPageHelp;
        document.getElementById("defaultParserHelpButton").onclick = onDefaultParserHelp;
        getLoadAndAnalyseButton().onclick = onLoadAndAnalyseButtonClick;
        document.getElementById("loadMetadataButton").onclick = onLoadMetadataButtonClick;

        document.getElementById("writeOptionsButton").onclick = () => userPreferences.writeToFile();
        document.getElementById("readOptionsInput").onchange = onReadOptionsFromFile;
        UserPreferences.getReadingListCheckbox().onclick = onReadingListCheckboxClicked;
        document.getElementById("viewReadingListButton").onclick = () => showReadingList();
        window.addEventListener("beforeunload", onUnloadEvent);
    }
	
	
    // Additional metadata
    function autosearchadditionalmetadata(){
        getPackEpubButton().disabled = true;
        document.getElementById("LibAddToLibrary").disabled = true;
        let titelname = getValueFromUiField("titleInput");
        let url ="https://www.novelupdates.com/?s="+titelname;
        if (getValueFromUiField("subjectInput")==null){
            autosearchnovelupdates(url, titelname);
        }   
        getPackEpubButton().disabled = false; 
        document.getElementById("LibAddToLibrary").disabled = false;    
    }
	
    function autosearchnovelupdates(url, titelname){
        return HttpClient.wrapFetch(url).then(function (xhr) {
            findnovelupdatesurl(url, xhr.responseXML, titelname);
        }).catch(function (error) {
            getLoadAndAnalyseButton().disabled = false;
            ErrorLog.showErrorMessage(error);
        });
    }

    function autosearchwlnupdates(url, titelname){
        url ="https://www.wlnupdates.com/search?title="+titelname;
        return HttpClient.wrapFetch(url).then(function (xhr) {
            findwlnupdatesurl(url, xhr.responseXML, titelname);
        }).catch(function (error) {
            getLoadAndAnalyseButton().disabled = false;
            ErrorLog.showErrorMessage(error);
        });
    }

    function findnovelupdatesurl(url, dom, titelname){
        try{    
            let searchurl = [...dom.querySelectorAll("a")].filter(a => a.textContent==titelname)[0];
            setUiFieldToValue("metadataUrlInput", searchurl.href);
            url = getValueFromUiField("metadataUrlInput");
            if (url.includes("novelupdates.com") == true){
                onLoadMetadataButtonClick();
            }
        }catch{
            autosearchwlnupdates(url, titelname);
        }
    }

    function findwlnupdatesurl(url, dom, titelname){
        try{    
            let searchurl = [...dom.querySelectorAll("a")].filter(a => a.textContent==titelname)[0];
            setUiFieldToValue("metadataUrlInput", searchurl.href);
            url = getValueFromUiField("metadataUrlInput");
            if (url.includes("wlnupdates.com") == true){
                onLoadMetadataButtonClick();
            }
        }catch{
            let test = "Error: Failed to auto fetch additional Metadata on novelupdates.com or wlnupdates.";
            ErrorLog.showErrorMessage(test);}
        getPackEpubButton().disabled = false;
        document.getElementById("LibAddToLibrary").disabled = false;
    }
	
    function onLoadMetadataButtonClick(){
        getPackEpubButton().disabled = true;
        document.getElementById("LibAddToLibrary").disabled = true;
        let url = getValueFromUiField("metadataUrlInput");
        return HttpClient.wrapFetch(url).then(function (xhr) {
            populateMetadataAddWithDom(url, xhr.responseXML);
        }).catch(function (error) {
            getLoadAndAnalyseButton().disabled = false;
            ErrorLog.showErrorMessage(error);
        });
    }

    function populateMetadataAddWithDom(url, dom) {
        try {
            let allTags = document.getElementById("lesstagsCheckbox").checked == false;
            let metaAddInfo = EpubMetaInfo.getEpubMetaAddInfo(dom, url, allTags);
            setUiFieldToValue("subjectInput", metaAddInfo.subject);
            setUiFieldToValue("descriptionInput", metaAddInfo.description);
            if (getValueFromUiField("authorInput")=="<unknown>"){
                setUiFieldToValue("authorInput", metaAddInfo.author);
            }
            getPackEpubButton().disabled = false;
            document.getElementById("LibAddToLibrary").disabled = false;
        } catch (error) {
            ErrorLog.showErrorMessage(error);
            getPackEpubButton().disabled = false;
            document.getElementById("LibAddToLibrary").disabled = false;
        }
    }

    // actions to do when window opened
    window.onload = function () {
        userPreferences = UserPreferences.readFromLocalStorage();
        if (isRunningInTabMode()) {
            console.log("is in tab mode, proceeding")
            localizeHtmlPage();
            getAdvancedOptionsSection().hidden = !userPreferences.advancedOptionsVisibleByDefault.value;
            populateControls(); // TODO moved this before event handlers, make sure no issue.
            addEventHandlers();
            if (util.isFirefox()) {
                Firefox.startWebRequestListeners();
            }
        } else {
            console.log("opening tab window since not in tab mode")
            openTabWindow();
        }
    }

    return {
        getPackEpubButton: getPackEpubButton,
        onLoadAndAnalyseButtonClick : onLoadAndAnalyseButtonClick
    };
})();
