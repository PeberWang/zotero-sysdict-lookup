// dictlookup — 从 macOS 系统词典（DictionaryServices）取出词条纯文本，以 JSON 输出
// 用法: dictlookup <word> [--order "A|B|C"] [--out /path/to/out.json]
//
// 依赖已废弃但仍随系统提供的 DictionaryServices 框架（DCSCopyTextDefinition）。
// 只读本地词典，不联网。
//
// 额外做一件事：PDF 里划词经常少选/多选最后一个字母（"colossa" / "colossall"），
// 直接查会落空。此时会尝试去掉末字母、或逐个补一个字母，唯一命中时按命中词返回，
// 并在 JSON 里用 completedFrom 标出原始选区。

#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>

// SDK 里已移除这两个符号的声明，但运行时仍在 CoreServices 中。
extern id DCSCopyAvailableDictionaries(void);
extern NSString *DCSDictionaryGetName(DCSDictionaryRef);

static NSArray<NSString *> *defaultOrder(void) {
    return @[
        @"New Oxford American Dictionary",
        @"Oxford Dictionary of English",
        @"牛津英汉汉英词典",
        @"Apple Dictionary",
    ];
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

    NSArray<NSString *> *chunks = [defs componentsSeparatedByString:@" \u2022 "];
    NSMutableArray<NSString *> *senses = [NSMutableArray array];
    NSArray *posWords = @[@"adjective", @"noun", @"verb", @"adverb", @"preposition",
                          @"conjunction", @"pronoun", @"interjection", @"determiner",
                          @"exclamation", @"modal verb", @"auxiliary verb"];
    for (NSString *chunk in chunks) {
        NSString *sense = [chunk stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (!sense.length) continue;

        for (NSString *pos in posWords) {
            if ([sense hasPrefix:pos]) {
                sense = [sense substringFromIndex:pos.length];
                break;
            }
        }
        sense = [sense stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];

        // 例证用冒号引出，精简时丢掉
        NSRange colon = [sense rangeOfString:@": "];
        if (colon.location != NSNotFound && colon.location > 0) {
            sense = [sense substringToIndex:colon.location];
        }
        if (sense.length > 90) sense = [[sense substringToIndex:88] stringByAppendingString:@"…"];
        if (sense.length) [senses addObject:sense];
        if (senses.count >= 3) break;
    }

    return @{
        @"headword": headword,
        @"ipa": ipa,
        @"senses": senses,
    };
}

static NSArray<NSDictionary *> *lookupEntries(NSString *word,
                                              NSDictionary<NSString *, id> *available,
                                              NSArray<NSString *> *order) {
    NSMutableArray *entries = [NSMutableArray array];
    for (NSString *name in (order ?: defaultOrder())) {
        id dict = available[name];
        if (!dict) continue;

        NSString *text = lookupInDictionary(dict, word);
        if (!text) continue;

        NSMutableDictionary *entry = [@{ @"dict": name, @"text": text } mutableCopy];
        [entry addEntriesFromDictionary:structureEntry(text)];
        [entries addObject:entry];
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

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSMutableArray<NSString *> *args = [NSMutableArray array];
        for (int i = 1; i < argc; i++) [args addObject:[NSString stringWithUTF8String:argv[i]]];

        NSString *outPath = argValue(args, @"--out");
        NSString *orderSpec = argValue(args, @"--order");

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
            if ([arg isEqualToString:@"--order"] || [arg isEqualToString:@"--out"]) {
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

        // 划词常见误差：多选或漏选末尾一个字母
        if (!entries.count && word.length >= 3) {
            NSString *shorter = [word substringToIndex:word.length - 1];
            NSArray *shorterEntries = lookupEntries(shorter, available, order);
            if (shorterEntries.count) {
                word = shorter;
                entries = shorterEntries;
            } else {
                NSMutableArray<NSDictionary *> *hits = [NSMutableArray array];
                for (char c = 'a'; c <= 'z'; c++) {
                    NSString *candidate = [word stringByAppendingFormat:@"%c", c];
                    NSArray *candidateEntries = lookupEntries(candidate, available, order);
                    if (candidateEntries.count) {
                        [hits addObject:@{ @"word": candidate, @"entries": candidateEntries }];
                    }
                }
                // 只有唯一补全时才采用，避免猜错
                if (hits.count == 1) {
                    word = hits[0][@"word"];
                    entries = hits[0][@"entries"];
                }
            }
        }

        result[@"word"] = word;
        result[@"entries"] = entries;
        if (![word isEqualToString:original]) result[@"completedFrom"] = original;

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
