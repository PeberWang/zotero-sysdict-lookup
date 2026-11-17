// dictlookup — 从 macOS 系统词典（DictionaryServices）取出词条纯文本，以 JSON 输出
// 用法: dictlookup <word> [--order "A|B|C"] [--stop-at-lang en] [--cache dictionaries.json] [--out /path/to/out.json]
//       dictlookup --list-dictionaries [--json] [--cache /path/to/dictionaries.json]
//         只读：列出能查英文词 / 汉字词的词典及探测出的解释语言，附系统首选语言列表
//
// 依赖已废弃但仍随系统提供的 DictionaryServices 框架（DCSCopyTextDefinition）。
// 只读本地词典，不联网。
//
// 额外做一件事：PDF 里划词经常少选/多选最后一个字母（"colossa" / "colossall"），
// 直接查会落空。此时会尝试去掉末字母、或逐个补一个字母，唯一命中时按命中词返回，
// 并在 JSON 里用 completedFrom 标出原始选区。

#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>
#import <NaturalLanguage/NaturalLanguage.h>

// SDK 里已移除这两个符号的声明，但运行时仍在 CoreServices 中。
extern id DCSCopyAvailableDictionaries(void);
extern NSString *DCSDictionaryGetName(DCSDictionaryRef);
extern CFURLRef DCSDictionaryGetURL(DCSDictionaryRef);

static NSArray<NSString *> *defaultOrder(void) {
    return @[
        @"New Oxford American Dictionary",
        @"Oxford Dictionary of English",
        @"牛津英汉汉英词典",
        @"Apple Dictionary",
    ];
}

typedef struct { NSUInteger han, latin, kana, hangul, other, simp, trad; } ScriptCount;

// 繁简对照字：只出现一边的字才计数
static NSString *const kSimpChars = @"们这说时为发对关见门问间车东书长学习语国过还进现实点开种动样经应该给让认识义线话总题机";
static NSString *const kTradChars = @"們這說時為發對關見門問間車東書長學習語國過還進現實點開種動樣經應該給讓認識義線話總題機";

static ScriptCount countScripts(NSString *text) {
    ScriptCount c = {0};
    for (NSUInteger i = 0; i < text.length; i++) {
        unichar ch = [text characterAtIndex:i];
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) c.latin++;
        else if (ch >= 0x4E00 && ch <= 0x9FFF) {
            c.han++;
            NSString *s = [NSString stringWithCharacters:&ch length:1];
            if ([kSimpChars containsString:s]) c.simp++;
            if ([kTradChars containsString:s]) c.trad++;
        }
        else if (ch >= 0x3040 && ch <= 0x30FF) c.kana++;
        else if (ch >= 0xAC00 && ch <= 0xD7AF) c.hangul++;
        else if ((ch >= 0x00C0 && ch <= 0x02FF) || (ch >= 0x1E00 && ch <= 0x1EFF)) continue;   // 带音标的拉丁字母、IPA、间距修饰符（ˈ ˇ）
        else if ((ch >= 0x3100 && ch <= 0x312F) || (ch >= 0x31A0 && ch <= 0x31BF)) continue;   // 注音符号
        else if ([[NSCharacterSet letterCharacterSet] characterIsMember:ch]) c.other++;     // 天城文、西里尔、阿拉伯…
    }
    return c;
}


static NSString *chineseScript(NSUInteger simp, NSUInteger trad) {
    if (simp > trad * 2) return @"zh-Hans";
    if (trad > simp * 2) return @"zh-Hant";
    return @"zh";
}

// 释义语言：以这本词典对这个词实际给出的文本为准
//   中日韩：看字符占比。英文词条里中文释义通常只占一成多（音标、例句都是拉丁字母），汉字词条里中文释义占大半
//   汉字词条、拉丁字母为主：视为英文释义（本机所有汉字词头的双语词典都是汉英）
//   拉丁词头、拉丁释义：判的是「释义」而不是词条里出现的字母——先剥掉词头及其屈折形式、音标、▸ 例句、
//   括号标签与词性词，再交给 NLLanguageRecognizer，并把候选语言限制在这本词典的语言对 {en, X} 之内。
//   语言对来自探测（英文探针词的释义语言 X），探测不确定时用词典名兜底。实测见 docs/languages.md

static NSString *foldText(NSString *s) {
    return [s stringByFoldingWithOptions:NSDiacriticInsensitiveSearch | NSCaseInsensitiveSearch locale:nil];
}

// 非释义段：词源、派生词、短语、用法说明、参见。它们里的外语词（from French, from Latin…）会把识别带偏
static NSString *stripNonGloss(NSString *text) {
    NSString *body = text;
    for (NSString *marker in @[@" ORIGIN", @" DERIVATIVES", @" DERIVATIVE", @" PHRASES", @" PHRASAL VERBS", @" USAGE"]) {
        NSRange r = [body rangeOfString:marker];
        if (r.location != NSNotFound) body = [body substringToIndex:r.location];
    }
    NSRange see = [body rangeOfString:@"see also" options:NSCaseInsensitiveSearch];
    if (see.location != NSNotFound) body = [body substringToIndex:see.location];
    return body;
}

static NSString *glossOf(NSString *text, NSString *word) {
    NSString *body = stripNonGloss(text);
    NSArray *patterns = @[
        @"\\|[^|]*\\|",                                   // | 音标 | 段（以及 | 分隔的词头注音）
        @"[▸▶][^▸▶•]*",                                  // Oxford 双语词典的例句与交叉引用
        @": [^•]*?(?=\\s\\d{1,2}\\s|•|$)",                // 单语词典冒号引出的例句
        @"\\([^)]*\\)|\\[[^\\]]*\\]|⟨[^⟩]*⟩|［[^］]*］",
    ];
    for (NSString *pattern in patterns) {
        body = [body stringByReplacingOccurrencesOfString:pattern withString:@" "
                                                  options:NSRegularExpressionSearch range:NSMakeRange(0, body.length)];
    }
    static NSSet *grammar;
    static NSCharacterSet *ipa;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        grammar = [NSSet setWithArray:@[@"noun", @"verb", @"adjective", @"adverb", @"masculine", @"feminine", @"neuter",
            @"plural", @"singular", @"uncountable", @"countable", @"transitive", @"intransitive", @"gen", @"pl",
            @"invariable", @"nom", @"femeni", @"masculi", @"adjectiu", @"adverbi", @"f", @"m", @"n", @"nf", @"nm",
            @"mf", @"sing", @"preposition", @"conjunction", @"pronoun", @"exclamation"]];
        ipa = [NSCharacterSet characterSetWithCharactersInString:@"ˈˌːəɐɑɒɔɛɜɪʊʌʃʒθðŋɣɾʎɲχʁɥøœ"];
    });
    NSString *head = foldText(word);
    NSString *stem = head.length > 3 ? [head substringToIndex:head.length - 1] : head;
    NSMutableArray *kept = [NSMutableArray array];
    for (NSString *raw in [body componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]) {
        NSString *tok = [raw stringByTrimmingCharactersInSet:NSCharacterSet.punctuationCharacterSet];
        if (!tok.length) continue;
        if ([tok rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet].location != NSNotFound) continue;
        if ([tok rangeOfCharacterFromSet:ipa].location != NSNotFound) continue;
        NSString *f = foldText(tok);
        if ([grammar containsObject:f]) continue;
        if (tok.length == 1) continue;                    // a b c 子项编号、性别标记
        // 词头、以词头开头的复合词（Wasserversorgung）与屈折形式（Häuser）；
        // 只共享词干的长词保留，避免误删同根的释义词（governo 的 government）
        if ([f hasPrefix:head]) continue;
        if ([f hasPrefix:stem] && f.length <= head.length + 2) continue;
        [kept addObject:tok];
        if (kept.count >= 250) break;
    }
    return [kept componentsJoinedByString:@" "];
}

// 词典名兜底：只在探测定不出语言对时使用
static NSString *nameLanguage(NSString *name) {
    static NSArray<NSArray<NSString *> *> *table;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        table = @[
            @[@"es", @"Español|Spanish|Española"], @[@"fr", @"Français|French|Hachette|française"],
            @[@"de", @"German|Deutsch"], @[@"ca", @"Català|Catalan|catalana"], @[@"it", @"italiano|Italian"],
            @[@"pt", @"Português|Portuguese"], @[@"nl", @"Nederlands|Dutch|Handwoordenboek Engels"],
            @[@"sv", @"Svensk|Swedish"], @[@"da", @"Dansk|Danish|Engelsk-Dansk"], @[@"nb", @"Norsk|Engelsk Ordbok"],
            @[@"pl", @"Polish|polsko|polskiego"], @[@"ru", @"Russian|Русско|русского"], @[@"tr", @"Turkish|Türkçe"],
            @[@"id", @"Indonesian|Indonesia"], @[@"ms", @"Malay(?!alam)|Melayu"], @[@"ml", @"Malayalam"], @[@"hu", @"Magyar"], @[@"fi", @"suomi"],
            @[@"cs", @"český|česko"], @[@"sk", @"Slovensk"], @[@"hr", @"Hrvatski|Chorvatský"],
            @[@"el", @"Greek|νεοελλην"], @[@"he", @"Hebrew|עברי"], @[@"ar", @"Arabic|عربي"], @[@"vi", @"Việt"],
            @[@"uk", @"Українсько"], @[@"kk", @"Қазақ"], @[@"th", @"ไทย"], @[@"hi", @"Hindi|हिन्दी"],
        ];
    });
    for (NSArray<NSString *> *row in table) {
        if ([name rangeOfString:row[1] options:NSRegularExpressionSearch | NSCaseInsensitiveSearch].location != NSNotFound) {
            return row[0];
        }
    }
    return nil;
}

// 语言对里的另一种语言 X（"en" 表示英英单语）；探测结果从 --cache 读入
static NSDictionary<NSString *, NSString *> *gPairs = nil;

static NSString *recognize(NSString *gloss, NSArray<NLLanguage> *constraints, double *confidence) {
    NLLanguageRecognizer *recognizer = [[NLLanguageRecognizer alloc] init];
    if (constraints) recognizer.languageConstraints = constraints;
    [recognizer processString:gloss];
    NSDictionary<NLLanguage, NSNumber *> *hyp = [recognizer languageHypothesesWithMaximum:1];
    NLLanguage lang = hyp.allKeys.firstObject;
    if (confidence) *confidence = lang ? hyp[lang].doubleValue : 0;
    return lang;
}

// basis：script（按文字）| text（按释义文本识别，高置信）| dictionary（低置信，按该词典的主语言）|
//        latin-default（低置信、词典主语言不明：释义里拉丁字母超过九成且无汉字假名，按英语）
// 低置信的猜测（以前输出的 "es?"）不再作为结果，免得被拿来否决（colossal 曾因词源里的 from French… 被判成 es?）
static NSString *explainLanguageDetail(NSString *text, NSString *word, BOOL hanHeadword, NSString *pairX,
                                       NSString **basis, NSString **guess) {
    if (basis) *basis = @"script";
    if (guess) *guess = nil;
    NSString *defs = stripNonGloss(text);
    ScriptCount c = countScripts(defs);
    double n = MAX(1.0, (double)(c.han + c.latin + c.kana + c.hangul + c.other));
    if (c.kana / n >= 0.05) return @"ja";
    if (c.hangul / n >= 0.05) return @"ko";
    if (c.han / n >= (hanHeadword ? 0.5 : 0.10)) {
        NSString *script = chineseScript(c.simp, c.trad);
        // 区分繁简的字没出现时（「巨大的」），用词典语言对里的简繁
        return [script isEqualToString:@"zh"] && [pairX hasPrefix:@"zh-"] ? pairX : script;
    }
    // 英汉词典的短词条（algebra：只有「代数」两个汉字，其余是音标与拼音）：语言对已知是中文时，有汉字即按中文
    if (!hanHeadword && c.han >= 2 && [pairX hasPrefix:@"zh"]) {
        NSString *script = chineseScript(c.simp, c.trad);
        return [script isEqualToString:@"zh"] ? pairX : script;
    }
    if (c.other / n >= 0.03) return @"other";
    if (c.latin / n < (hanHeadword ? 0.6 : 0.9)) return @"other";
    if (hanHeadword) return @"en";

    BOOL latinOnly = c.latin / n >= 0.9 && c.han == 0 && c.kana == 0;
    NSString *gloss = glossOf(text, word);
    double conf = 0;
    NSString *lang = nil;
    BOOL bilingual = pairX.length && ![pairX isEqualToString:@"en"] && ![pairX hasSuffix:@"?"];
    if (gloss.length) {
        if (bilingual) {
            lang = recognize(gloss, @[NLLanguageEnglish, pairX], &conf);
            if (lang && conf >= 0.6) { if (basis) *basis = @"text"; return lang; }
        } else {
            lang = recognize(gloss, nil, &conf);
            if ([lang isEqualToString:NLLanguageEnglish] && conf >= 0.9) { if (basis) *basis = @"text"; return @"en"; }
        }
    }
    // 低置信：不拿猜测否决，先按词典主语言认定（英英单语词典 → en），再按拉丁字母规则
    if (guess && lang) *guess = [NSString stringWithFormat:@"%@ %.2f", lang, conf];
    if ([pairX isEqualToString:@"en"]) { if (basis) *basis = @"dictionary"; return @"en"; }
    if (latinOnly) { if (basis) *basis = @"latin-default"; return @"en"; }
    if (basis) *basis = @"low-confidence";
    return @"other";
}

static NSString *explainLanguage(NSString *text, NSString *word, BOOL hanHeadword, NSString *pairX) {
    return explainLanguageDetail(text, word, hanHeadword, pairX, NULL, NULL);
}

static BOOL isHanWord(NSString *word) {
    ScriptCount c = countScripts(word);
    return c.han > 0 && c.han >= c.latin;
}

static NSString *lookupInDictionary(id dict, NSString *word) {
    DCSDictionaryRef ref = (__bridge DCSDictionaryRef)dict;
    CFStringRef w = (__bridge CFStringRef)word;
    CFRange range = DCSGetTermRangeInString(ref, w, 0);
    if (range.location == kCFNotFound) return nil;

    CFStringRef definition = DCSCopyTextDefinition(ref, w, range);
    if (!definition) return nil;

    NSString *text = (__bridge_transfer NSString *)definition;
    text = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    return text.length ? text : nil;
}

// 把牛津词条拆成：词头 / 音标 / 若干条简明释义
static NSDictionary *structureEntry(NSString *text) {
    NSArray<NSString *> *parts = [text componentsSeparatedByString:@" | "];

    NSString *head = parts.firstObject ?: text;
    NSString *headword = head;
    NSRange space = [head rangeOfString:@" "];
    if (space.location != NSNotFound) headword = [head substringToIndex:space.location];
    headword = [headword stringByReplacingOccurrencesOfString:@"\u00b7" withString:@""];

    NSString *ipa = @"";
    NSString *defs = text;
    if (parts.count >= 3) {
        ipa = parts[1];
        defs = [[parts subarrayWithRange:NSMakeRange(2, parts.count - 2)] componentsJoinedByString:@" | "];
    } else if (parts.count == 2) {
        ipa = parts[1];
        defs = @"";
    }

    // 去掉派生词与词源，只留释义
    for (NSString *cut in @[@" DERIVATIVES", @" ORIGIN", @" PHRASES", @" DERIVATIVE"]) {
        NSRange r = [defs rangeOfString:cut];
        if (r.location != NSNotFound) defs = [defs substringToIndex:r.location];
    }

    // 按 • 与义项编号（1 2 …）一起切开：只按 • 切时，「1 a title… • an autocrat. 2 Medicine…」会出现
    // 一条带编号、一条不带，还把第 2 义并进上一条（Caesar）
    // 句中的另一词性段（「…law courts. verb (decrees | …|) … order…」）也是切点，不并进上一条（decree）
    NSString *marked = [defs stringByReplacingOccurrencesOfString:@"(?:\\s\u2022\\s|(?:^|\\s)\\d{1,2}\\s(?=[A-Za-z(\\[])|[.;]\\s+(?=(?:noun|verb|adjective|adverb|preposition|conjunction|pronoun|determiner|exclamation|interjection)\\b))"
                                                       withString:@"\uE000" options:NSRegularExpressionSearch
                                                            range:NSMakeRange(0, defs.length)];
    NSArray<NSString *> *chunks = [marked componentsSeparatedByString:@"\uE000"];
    NSMutableArray<NSString *> *senses = [NSMutableArray array];
    NSArray *posWords = @[@"adjective", @"noun", @"verb", @"adverb", @"preposition",
                          @"conjunction", @"pronoun", @"interjection", @"determiner",
                          @"exclamation", @"modal verb", @"auxiliary verb"];
    for (NSString *chunk in chunks) {
        NSString *sense = [chunk stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (!sense.length) continue;

        // 音标只留在标题行：义项里的变位表与读音（「(decrees | dəˈkrēz |)」「(, decreeing | … |)」）、
        // 「| … |」读音段一律删
        for (NSString *pattern in @[@"\\([^()]*\\|[^()]*\\)", @"\\|[^|]*\\|", @"\\|"]) {
            sense = [sense stringByReplacingOccurrencesOfString:pattern withString:@" "
                                                        options:NSRegularExpressionSearch range:NSMakeRange(0, sense.length)];
        }
        sense = [sense stringByReplacingOccurrencesOfString:@"\\s{2,}" withString:@" "
                                                    options:NSRegularExpressionSearch range:NSMakeRange(0, sense.length)];
        sense = [sense stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];

        // 开头的「(also régime)」变体标注、词性、编号，按任意顺序剥掉
        for (int pass = 0; pass < 3; pass++) {
            // (also régime)、(British English also organisation)、[with object] 这类标签
            sense = [sense stringByReplacingOccurrencesOfString:@"^(?:\\([^()]*\\balso\\b[^()]*\\)|\\[[^\\]]*\\])\\s*" withString:@""
                                                        options:NSRegularExpressionSearch range:NSMakeRange(0, sense.length)];
            sense = [sense stringByReplacingOccurrencesOfString:@"^(?:masculine|feminine|neuter|plural|countable|uncountable)\\s+(?=noun|verb|adjective)" withString:@""
                                                        options:NSRegularExpressionSearch range:NSMakeRange(0, sense.length)];
            for (NSString *pos in posWords) {
                if ([sense hasPrefix:pos]) {
                    sense = [[sense substringFromIndex:pos.length] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
                    break;
                }
            }
            sense = [sense stringByReplacingOccurrencesOfString:@"^(?:\\(?\\d{1,2}[.)]?|（\\d{1,2}）|[\u2460-\u2473]|[a-h][.)])\\s*"
                                                     withString:@"" options:NSRegularExpressionSearch
                                                          range:NSMakeRange(0, sense.length)];
        }
        sense = [sense stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];

        // 例证用冒号引出，精简时丢掉
        NSRange colon = [sense rangeOfString:@": "];
        if (colon.location != NSNotFound && colon.location > 0) {
            sense = [sense substringToIndex:colon.location];
        }
        // 「See also …」是参见，不是释义
        NSRange see = [sense rangeOfString:@" See also " options:0];
        if (see.location != NSNotFound) sense = [sense substringToIndex:see.location];
        sense = [sense stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@" ."]];
        // 剥完只剩空串或数字：丢弃，不渲染孤立编号
        if (!sense.length || [sense rangeOfString:@"^\\d+$" options:NSRegularExpressionSearch].location != NSNotFound) continue;
        // 不在这里截断：显示层按词边界截成两行（以前 88 字硬切会切断单词，如 advanc…）。只防极端长段
        if (sense.length > 400) sense = [sense substringToIndex:400];
        [senses addObject:sense];
        if (senses.count >= 3) break;
    }

    return @{
        @"headword": headword,
        @"ipa": ipa,
        @"senses": senses,
    };
}

// 设了 gStopAtLang 时，遇到第一条释义语言恰好是它的词条就停（「命中即用，不再往后找」），后面的词典不再查
static NSString *gStopAtLang = nil;

static NSArray<NSDictionary *> *lookupEntries(NSString *word,
                                              NSDictionary<NSString *, id> *available,
                                              NSArray<NSString *> *order) {
    NSMutableArray *entries = [NSMutableArray array];
    for (NSString *name in (order ?: defaultOrder())) {
        id dict = available[name];
        if (!dict) continue;

        NSString *text = lookupInDictionary(dict, word);
        if (!text) continue;

        NSString *basis = nil, *guess = nil;
        NSString *explains = explainLanguageDetail(text, word, isHanWord(word), gPairs[name] ?: nameLanguage(name),
                                                   &basis, &guess);
        NSMutableDictionary *entry = [@{ @"dict": name, @"text": text, @"explains": explains,
                                         @"explainsBasis": basis } mutableCopy];
        if (guess) entry[@"explainsGuess"] = guess;     // 低置信时识别器的原始猜测，只供排查
        [entry addEntriesFromDictionary:structureEntry(text)];
        [entries addObject:entry];
        if (gStopAtLang && [entry[@"explains"] isEqualToString:gStopAtLang]) break;
    }

    // NOAD 与 ODE 是同源词典，内容几乎一致；命中 NOAD 时不再重复显示 ODE
    BOOL hasNOAD = NO;
    for (NSDictionary *entry in entries) {
        if ([entry[@"dict"] isEqualToString:@"New Oxford American Dictionary"]) hasNOAD = YES;
    }
    if (hasNOAD) {
        NSMutableArray *filtered = [NSMutableArray array];
        for (NSDictionary *entry in entries) {
            if ([entry[@"dict"] isEqualToString:@"Oxford Dictionary of English"]) continue;
            [filtered addObject:entry];
        }
        entries = filtered;
    }

    return entries;
}

// 把非 ASCII 字符转成 \uXXXX：跨进程传 JSON 时不受 stdout 编码影响
static NSString *asciiSafeJSON(NSString *json) {
    NSMutableString *out = [NSMutableString stringWithCapacity:json.length];
    for (NSUInteger i = 0; i < json.length; i++) {
        unichar c = [json characterAtIndex:i];
        if (c < 128) {
            [out appendFormat:@"%C", c];
        } else {
            [out appendFormat:@"\\u%04x", c];
        }
    }
    return out;
}



static NSString *argValue(NSArray<NSString *> *args, NSString *flag) {
    NSUInteger i = [args indexOfObject:flag];
    if (i == NSNotFound || i + 1 >= args.count) return nil;
    return args[i + 1];
}

/* ---------------- 词典能力探测（--list-dictionaries，只读） ----------------
 *
 * 系统不公开词典的语言对，词典名又是本地化的，所以不看名字，用探针：
 * 每本词典分别查几个英文词和几个汉字词，统计返回文本里汉字 / 拉丁字母 / 假名 / 谚文的占比，
 * 推断「查英文词时用什么语言解释」和「查汉字词时用什么语言解释」。
 * 结果按「词典集合 + 系统版本」签名缓存，签名不变就直接返回缓存。
 */



// 对一组探针词的结果做判断；命中不足一半返回 nil（视为不能查这类词）
//   汉字组：每个命中词按 explainLanguage 判定，取多数
//   拉丁组：英文探针词的释义语言 X 定出语言对 {en, X}。每个命中词先剥掉词头与例句，不加约束地识别；
//   多数票落在同一非英语语言（≥ 2 票）即为 X；全部是高置信英语则为英英单语（X = en）；
//   都不成立时用词典名兜底（source = "name"），名字也认不出就记 "?"
static NSDictionary *probeGroup(id dict, NSString *name, NSArray<NSArray<NSString *> *> *probes, BOOL hanHeadword) {
    NSUInteger hits = 0;
    NSCountedSet *votes = [NSCountedSet set];
    NSUInteger englishSure = 0;
    for (NSArray<NSString *> *variants in probes) {
        NSString *text = nil, *used = nil;
        for (NSString *w in variants) {
            text = lookupInDictionary(dict, w);
            if (text) { used = w; break; }
        }
        if (!text) continue;
        hits++;
        NSString *script = explainLanguage(text, used, hanHeadword, @"en");
        if (hanHeadword || ![script isEqualToString:@"en"] && ![script hasSuffix:@"?"]) {
            [votes addObject:script];           // 中日韩或其他文字，直接按文字判
            continue;
        }
        double conf = 0;
        NSString *lang = recognize(glossOf(text, used), nil, &conf);
        if ([lang isEqualToString:NLLanguageEnglish] && conf >= 0.9) englishSure++;
        if (lang) [votes addObject:lang];
    }
    if (hits * 2 < probes.count) return nil;

    NSString *top = nil;
    NSUInteger best = 0;
    for (NSString *lang in votes) {
        NSUInteger k = [votes countForObject:lang];
        if (k > best || (k == best && [lang compare:top] == NSOrderedAscending)) { best = k; top = lang; }
    }
    NSMutableDictionary *out = [@{ @"hits": @(hits), @"of": @(probes.count) } mutableCopy];
    if (hanHeadword) {
        out[@"explains"] = top ?: @"other";
        return out;
    }
    NSString *source = @"probe";
    NSString *x = nil;
    BOOL cjkOrOther = [top hasPrefix:@"zh"] || [top isEqualToString:@"ja"] || [top isEqualToString:@"ko"] || [top isEqualToString:@"other"];
    if (cjkOrOther) {
        x = top;
        // 西里尔、希腊、阿拉伯等文字只能判出「不是拉丁字母」，语言码用词典名补
        if ([top isEqualToString:@"other"] && nameLanguage(name)) { x = nameLanguage(name); source = @"name"; }
    } else if (englishSure == hits) {
        x = @"en";
    } else if (top && ![top isEqualToString:NLLanguageEnglish] && best >= 2) {
        x = top;
    } else if ((x = nameLanguage(name))) {
        source = @"name";
    } else {
        x = [(top ?: @"other") stringByAppendingString:@"?"];
    }
    out[@"explains"] = x;                       // 查英文词时用什么语言解释
    out[@"pair"] = [x isEqualToString:@"en"] ? @[@"en"] : @[@"en", x];
    out[@"pairSource"] = source;
    return out;
}

static NSString *signatureFor(NSArray<NSString *> *parts) {
    uint64_t h = 1469598103934665603ULL;   // FNV-1a
    for (NSString *part in parts) {
        const char *s = part.UTF8String;
        while (*s) { h ^= (unsigned char)*s++; h *= 1099511628211ULL; }
        h ^= 0x1f; h *= 1099511628211ULL;
    }
    return [NSString stringWithFormat:@"%016llx", h];
}

static int listDictionaries(NSString *cachePath, NSString *outPath) {
    NSMutableArray *dicts = [NSMutableArray array];
    NSMutableArray<NSString *> *sigParts = [NSMutableArray array];
    for (id dict in (NSSet *)DCSCopyAvailableDictionaries()) {
        NSString *name = DCSDictionaryGetName((__bridge DCSDictionaryRef)dict);
        if (!name) continue;
        // 未下载的词典没有 URL。对它查词会让系统在后台下载词典资源（实测），探测绝不碰它
        if (!DCSDictionaryGetURL((__bridge DCSDictionaryRef)dict)) continue;
        [dicts addObject:@[name, dict]];
        [sigParts addObject:name];
    }
    [sigParts sortUsingSelector:@selector(compare:)];
    [sigParts addObject:[NSProcessInfo processInfo].operatingSystemVersionString];
    // 探测算法版本：判定规则一改，旧缓存就失效（v2：按语言对判定；v3：切掉词源等非释义段，低置信不否决）
    [sigParts addObject:@"probe-v3"];
    NSString *signature = signatureFor(sigParts);

    NSMutableDictionary *result = nil;
    if (cachePath.length) {
        NSData *data = [NSData dataWithContentsOfFile:cachePath];
        NSDictionary *cached = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        if ([cached isKindOfClass:[NSDictionary class]] && [cached[@"signature"] isEqual:signature]) {
            result = [cached mutableCopy];
            result[@"cached"] = @YES;
        }
    }

    if (!result) {
        NSArray *latinProbes = @[@[@"water"], @[@"house"], @[@"government"], @[@"people"]];
        NSArray *hanProbes = @[@[@"水"], @[@"政府"], @[@"学习", @"學習"], @[@"国家", @"國家"]];
        NSDate *start = [NSDate date];
        NSMutableArray *found = [NSMutableArray array];
        for (NSArray *pair in dicts) {
            NSDictionary *latin = probeGroup(pair[1], pair[0], latinProbes, NO);
            NSDictionary *han = probeGroup(pair[1], pair[0], hanProbes, YES);
            if (!latin && !han) continue;   // 未下载或与英文 / 汉字都无关的词典
            NSMutableDictionary *info = [@{ @"name": pair[0] } mutableCopy];
            if (latin) info[@"latin"] = latin;
            if (han) info[@"han"] = han;
            [found addObject:info];
        }
        [found sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
            return [a[@"name"] compare:b[@"name"]];
        }];
        result = [@{
            @"signature": signature,
            @"probedAt": @((long long)([[NSDate date] timeIntervalSince1970] * 1000)),
            @"probeMs": @((long long)(-[start timeIntervalSinceNow] * 1000)),
            @"scanned": @(dicts.count),
            @"dictionaries": found,
        } mutableCopy];
        if (cachePath.length) {
            NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
            [json writeToFile:cachePath atomically:YES];
        }
        result[@"cached"] = @NO;
    }

    // 系统首选语言列表每次现读，不进缓存
    result[@"systemLanguages"] = [NSLocale preferredLanguages];

    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    NSString *output = asciiSafeJSON([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    if (outPath) {
        [output writeToFile:outPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
    } else {
        fwrite(output.UTF8String, 1, strlen(output.UTF8String), stdout);
        fputc('\n', stdout);
    }
    return 0;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSMutableArray<NSString *> *args = [NSMutableArray array];
        for (int i = 1; i < argc; i++) [args addObject:[NSString stringWithUTF8String:argv[i]]];

        NSString *outPath = argValue(args, @"--out");
        NSString *orderSpec = argValue(args, @"--order");

        gStopAtLang = argValue(args, @"--stop-at-lang");

        if ([args containsObject:@"--list-dictionaries"]) {
            return listDictionaries(argValue(args, @"--cache"), outPath);
        }

        // 查词模式：从探测缓存读每本词典的语言对，供释义语言判定（没有缓存就用词典名兜底）
        NSString *cachePath = argValue(args, @"--cache");
        if (cachePath.length) {
            NSData *data = [NSData dataWithContentsOfFile:cachePath];
            NSDictionary *cached = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
            NSMutableDictionary *pairs = [NSMutableDictionary dictionary];
            for (NSDictionary *d in cached[@"dictionaries"]) {
                NSString *x = d[@"latin"][@"explains"];
                if (x) pairs[d[@"name"]] = x;
            }
            gPairs = pairs;
        }

        NSArray<NSString *> *order = nil;
        if (orderSpec.length) {
            NSMutableArray *names = [NSMutableArray array];
            for (NSString *piece in [orderSpec componentsSeparatedByString:@"|"]) {
                NSString *trimmed = [piece stringByTrimmingCharactersInSet:
                                     [NSCharacterSet whitespaceAndNewlineCharacterSet]];
                if (trimmed.length) [names addObject:trimmed];
            }
            if (names.count) order = names;
        }

        // 去掉 --order/--out 及其值，剩下的是待查词
        NSMutableArray<NSString *> *positional = [NSMutableArray array];
        for (NSUInteger i = 0; i < args.count; i++) {
            NSString *arg = args[i];
            if ([arg isEqualToString:@"--order"] || [arg isEqualToString:@"--out"] ||
                [arg isEqualToString:@"--stop-at-lang"] || [arg isEqualToString:@"--cache"]) {
                i++;  // 跳过值
                continue;
            }
            if ([arg hasPrefix:@"--"]) continue;
            [positional addObject:arg];
        }

        NSMutableDictionary *result = [NSMutableDictionary dictionary];

        if (!positional.count) {
            result[@"error"] = @"no word given";
            return 2;
        }

        NSString *original = [positional componentsJoinedByString:@" "];

        // 词典表：名称 → DCSDictionaryRef
        NSMutableDictionary<NSString *, id> *available = [NSMutableDictionary dictionary];
        for (id dict in (NSSet *)DCSCopyAvailableDictionaries()) {
            NSString *name = DCSDictionaryGetName((__bridge DCSDictionaryRef)dict);
            if (name) available[name] = dict;
        }

        NSString *word = original;
        NSArray *entries = lookupEntries(word, available, order);

        // 划词常见误差：多选或漏选末尾一个字母。
        // 「去掉末字母」与「补一个字母」都算候选；带 --stop-at-lang 时优先选有目标语言释义的候选。
        // 以前只要去字母能命中就停，结果依赖词典顺序：插件顺序里譯典通排第 4，把 anthropologica 定成了
        // anthropologic（只有繁中释义），而默认顺序下会补成 anthropological（NOAD，英文释义）
        NSMutableArray<NSDictionary *> *completionLog = nil;
        if (!entries.count && word.length >= 3) {
            // 补全要试 27 次，只在顺序前 4 本里试，开销与 0.3.x 的默认 4 本相同
            NSArray *completionOrder = order && order.count > 4 ? [order subarrayWithRange:NSMakeRange(0, 4)] : order;
            BOOL (^hasTarget)(NSArray *) = ^BOOL(NSArray *es) {
                if (!gStopAtLang) return es.count > 0;
                for (NSDictionary *e in es) if ([e[@"explains"] isEqualToString:gStopAtLang]) return YES;
                return NO;
            };
            NSString *shorter = [word substringToIndex:word.length - 1];
            NSArray *shorterEntries = lookupEntries(shorter, available, completionOrder);

            NSMutableArray<NSDictionary *> *hits = [NSMutableArray array];
            if (!shorterEntries.count || !hasTarget(shorterEntries)) {
                for (char c = 'a'; c <= 'z'; c++) {
                    NSString *candidate = [word stringByAppendingFormat:@"%c", c];
                    NSArray *candidateEntries = lookupEntries(candidate, available, completionOrder);
                    if (candidateEntries.count) {
                        [hits addObject:@{ @"word": candidate, @"entries": candidateEntries }];
                    }
                }
            }
            completionLog = [NSMutableArray array];
            if (shorterEntries.count) [completionLog addObject:@{ @"word": shorter, @"target": @(hasTarget(shorterEntries)) }];
            for (NSDictionary *h in hits) [completionLog addObject:@{ @"word": h[@"word"], @"target": @(hasTarget(h[@"entries"])) }];

            NSMutableArray<NSDictionary *> *withTarget = [NSMutableArray array];
            if (shorterEntries.count && hasTarget(shorterEntries)) [withTarget addObject:@{ @"word": shorter, @"entries": shorterEntries }];
            for (NSDictionary *h in hits) if (hasTarget(h[@"entries"])) [withTarget addObject:h];

            if (withTarget.count >= 1 && (withTarget.count == 1 || [withTarget[0][@"word"] isEqualToString:shorter])) {
                // 唯一一个有目标语言释义的候选；或多个时沿用「去字母优先」
                word = withTarget[0][@"word"];
                entries = withTarget[0][@"entries"];
            } else if (!gStopAtLang || !withTarget.count) {
                // 没有目标语言候选：沿用旧规则（去字母命中即用；补字母须唯一）
                if (shorterEntries.count) {
                    word = shorter;
                    entries = shorterEntries;
                } else if (hits.count == 1) {
                    word = hits[0][@"word"];
                    entries = hits[0][@"entries"];
                }
            }
        }

        result[@"word"] = word;
        result[@"entries"] = entries;
        result[@"wordScript"] = isHanWord(word) ? @"han" : @"latin";
        if (![word isEqualToString:original]) result[@"completedFrom"] = original;
        if (completionLog.count) result[@"completionCandidates"] = completionLog;   // 补全试过的候选，供排查

        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        NSString *output = asciiSafeJSON([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);

        if (outPath) {
            [output writeToFile:outPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
        } else {
            fwrite(output.UTF8String, 1, strlen(output.UTF8String), stdout);
            fputc('\n', stdout);
        }
    }
    return 0;
}
