import { describe, expect, it } from "vitest";
import {
  checkPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordContext,
} from "./password-policy.js";

/**
 * A non-trivial, non-common text of exactly `n` code points, built from a
 * Spanish phrase without personal or service words.
 */
function ofLength(n: number): string {
  const base = "el rio suena fuerte cuando llueve sobre la sierra madre oriental ";
  return [...base.repeat(Math.ceil(n / base.length) + 1)].slice(0, n).join("");
}

describe("checkPasswordPolicy: length (15 to 128 code points)", () => {
  it("uses 15 and 128 as limits", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(15);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  it("rejects 14 characters with PASSWORD_TOO_SHORT", () => {
    expect(checkPasswordPolicy(ofLength(14))).toBe("PASSWORD_TOO_SHORT");
  });

  it("accepts exactly 15 characters (lower boundary)", () => {
    expect(checkPasswordPolicy(ofLength(15))).toBeNull();
  });

  it("accepts exactly 128 characters (upper boundary)", () => {
    expect(checkPasswordPolicy(ofLength(128))).toBeNull();
  });

  it("rejects 129 characters with PASSWORD_TOO_LONG", () => {
    expect(checkPasswordPolicy(ofLength(129))).toBe("PASSWORD_TOO_LONG");
  });

  it("rejects the empty string as too short", () => {
    expect(checkPasswordPolicy("")).toBe("PASSWORD_TOO_SHORT");
  });

  it("counts an emoji as ONE character, not as two UTF-16 units", () => {
    // 14 code points but 17 UTF-16 units: still too short.
    const fourteen = "tacos 🌮🌮🌮 hoy!";
    expect([...fourteen]).toHaveLength(14);
    expect(fourteen.length).toBeGreaterThanOrEqual(15);
    expect(checkPasswordPolicy(fourteen)).toBe("PASSWORD_TOO_SHORT");

    const fifteen = "tacos 🌮🌮🌮 hoy!!";
    expect([...fifteen]).toHaveLength(15);
    expect(checkPasswordPolicy(fifteen)).toBeNull();
  });

  it("128 emoji are accepted and 129 are too long (code points, not UTF-16 units)", () => {
    const emoji = ["🌮", "🌵", "🎉", "🦉", "🚲"];
    const make = (n: number) => Array.from({ length: n }, (_, i) => emoji[i % emoji.length]).join("");
    expect(make(128).length).toBe(256);
    expect(checkPasswordPolicy(make(128))).toBeNull();
    expect(checkPasswordPolicy(make(129))).toBe("PASSWORD_TOO_LONG");
  });

  it("counts ñ as one character", () => {
    // "mañana sin sol" = 14 code points.
    expect(checkPasswordPolicy("mañana sin sol")).toBe("PASSWORD_TOO_SHORT");
    expect(checkPasswordPolicy("mañana sin sol!")).toBeNull();
  });

  it("measures length AFTER NFKC: a decomposed ñ (n + combining tilde) still counts as one", () => {
    const decomposed = "mañana sin sol"; // 15 UTF-16 units / code points before NFKC, 14 after
    expect([...decomposed]).toHaveLength(15);
    expect(checkPasswordPolicy(decomposed)).toBe("PASSWORD_TOO_SHORT");
  });

  it("accepts spaces anywhere, including leading and trailing ones (never trimmed)", () => {
    expect(checkPasswordPolicy("  correcto caballo bateria  ")).toBeNull();
    // 13 visible characters + 2 spaces = 15: the spaces count toward the length.
    expect(checkPasswordPolicy(" correcto cab ")).toBe("PASSWORD_TOO_SHORT");
    expect(checkPasswordPolicy(" correcto cabx ")).toBeNull();
  });

  it("accepts any Unicode: accents, Cyrillic, CJK and symbols", () => {
    expect(checkPasswordPolicy("contraseña très ünïcødé")).toBeNull();
    expect(checkPasswordPolicy("пароль очень длинный 密码很长")).toBeNull();
    expect(checkPasswordPolicy("¿¡€ ∑ ∞ ≠ → ← ☃ ♥ ♫!?")).toBeNull();
  });
});

describe("checkPasswordPolicy: common and trivial passwords → PASSWORD_TOO_COMMON", () => {
  it("rejects a real entry of data/common-passwords.txt", () => {
    expect(checkPasswordPolicy("abcddesignbuild")).toBe("PASSWORD_TOO_COMMON");
    expect(checkPasswordPolicy("!qazxsw2#edcvfr4")).toBe("PASSWORD_TOO_COMMON");
  });

  it("rejects a list entry written in uppercase or mixed case", () => {
    expect(checkPasswordPolicy("ABCDDESIGNBUILD")).toBe("PASSWORD_TOO_COMMON");
    expect(checkPasswordPolicy("AbcdDesignBuild")).toBe("PASSWORD_TOO_COMMON");
  });

  it("rejects a list entry with spaces inserted (spaces are ignored for the list)", () => {
    expect(checkPasswordPolicy("abcd design build")).toBe("PASSWORD_TOO_COMMON");
  });

  it("ignores comment lines of the list (they are not passwords)", () => {
    // The header line of the file; it must not be treated as a common password.
    expect(checkPasswordPolicy("# Common and breached passwords of 15 to 128 characters, lowercased and")).not.toBe(
      "PASSWORD_TOO_COMMON",
    );
  });

  it.each([
    ["one repeated character", "aaaaaaaaaaaaaaa"],
    ["one repeated character in uppercase", "AAAAAAAAAAAAAAAA"],
    ["only spaces", "                "],
    ["two alternating characters", "abababababababab"],
    ["three characters repeated", "abcabcabcabcabcabc"],
    ["ascending letters", "abcdefghijklmnop"],
    ["ascending letters in uppercase", "ABCDEFGHIJKLMNOP"],
    ["descending letters", "zyxwvutsrqponmlk"],
    ["ascending digits that wrap around 9→0", "123456789012345"],
    ["descending digits that wrap around 0→9", "987654321098765"],
    ["ascending digits starting at 0", "0123456789012345"],
  ])("rejects a trivial pattern: %s (%s)", (_label, password) => {
    expect(checkPasswordPolicy(password)).toBe("PASSWORD_TOO_COMMON");
  });

  it("does not treat a long, varied phrase as trivial", () => {
    expect(checkPasswordPolicy("caballo correcto bateria grapa")).toBeNull();
    expect(checkPasswordPolicy("8273 9461 0583 2719")).toBeNull();
  });

  it("checks length before the list: a short common password is TOO_SHORT", () => {
    expect(checkPasswordPolicy("aaaaaaaaaaaaaa")).toBe("PASSWORD_TOO_SHORT");
  });
});

describe("checkPasswordPolicy: personal data as WHOLE words only", () => {
  const ana: PasswordContext = { firstName: "Ana", lastName: "Lopez", email: "ana.lopez@empresa.com" };
  const eva: PasswordContext = { firstName: "Eva", lastName: "Garza", email: "egarza@empresa.com" };
  const luz: PasswordContext = { firstName: "Luz", lastName: "Mendoza", email: "lmendoza@empresa.com" };

  describe("short Mexican first names (3 letters) still count, but never as substrings", () => {
    it("Ana: 'mi banana favorita del mercado' is accepted (banana contains 'ana')", () => {
      expect(checkPasswordPolicy("mi banana favorita del mercado", ana)).toBeNull();
    });

    it("Ana: 'me gusta la banana con miel' is accepted", () => {
      expect(checkPasswordPolicy("me gusta la banana con miel", ana)).toBeNull();
    });

    it("Ana: a single word containing the name ('bananasplitconcrema') is accepted", () => {
      expect(checkPasswordPolicy("bananasplitconcrema", ana)).toBeNull();
    });

    it("Eva: 'evaluacion del proyecto final' and its accented form are accepted", () => {
      expect(checkPasswordPolicy("evaluacion del proyecto final", eva)).toBeNull();
      expect(checkPasswordPolicy("evaluación del proyecto final", eva)).toBeNull();
    });

    it("Luz: 'luzbel y sus amigos cantan' is accepted", () => {
      expect(checkPasswordPolicy("luzbel y sus amigos cantan", luz)).toBeNull();
    });

    it("Ana: the whole word separated by dashes is rejected ('ana-come-tacos-diario')", () => {
      expect(checkPasswordPolicy("ana-come-tacos-diario", ana)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("Luz: the whole word separated by spaces is rejected ('luz del dia en monterrey')", () => {
      expect(checkPasswordPolicy("luz del dia en monterrey", luz)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("Eva: the whole word at the end of the phrase is rejected", () => {
      expect(checkPasswordPolicy("el proyecto final de eva", eva)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("Ana: uppercase and accents do not hide the name ('ÁNA come tacos al pastor')", () => {
      expect(checkPasswordPolicy("ÁNA come tacos al pastor", ana)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
      expect(checkPasswordPolicy("ANA COME TACOS AL PASTOR", ana)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("accents in the stored name do not hide it either (firstName 'Ána' vs 'ana')", () => {
      expect(checkPasswordPolicy("ana come tacos al pastor", { firstName: "Ána" })).toBe(
        "PASSWORD_CONTAINS_PERSONAL_INFO",
      );
    });

    it("the switch between letters and digits separates words ('ana2026 tacos al pastor' is rejected)", () => {
      expect(checkPasswordPolicy("ana2026 tacos al pastor", ana)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
      expect(checkPasswordPolicy("2026ana tacos al pastor", ana)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
      expect(checkPasswordPolicy("ana!2026 tacos al pastor", ana)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("digits next to a longer word do not create false positives ('banana2026 con miel y canela')", () => {
      expect(checkPasswordPolicy("banana2026 con miel y canela", ana)).toBeNull();
      expect(checkPasswordPolicy("luzbel99 y sus amigos cantan", luz)).toBeNull();
    });

    it("the last name also counts as a whole word", () => {
      expect(checkPasswordPolicy("familia lopez en la playa", ana)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
      expect(checkPasswordPolicy("familialopezenlaplaya", ana)).toBeNull();
    });
  });

  describe("email local part, split by '.', '-' and '_'", () => {
    const juan: PasswordContext = { email: "juan.perez_mx@empresa.com" };

    it("rejects 'perez' as a whole word", () => {
      expect(checkPasswordPolicy("la familia perez come tacos", juan)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("rejects 'juan' as a whole word (4 letters)", () => {
      expect(checkPasswordPolicy("juan come tacos al pastor", juan)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("rejects the local part written together ('juanperez') but not inside a longer word", () => {
      const juanPerez: PasswordContext = { email: "juan.perez@empresa.com" };
      expect(checkPasswordPolicy("juanperez en la playa de mazatlan", juanPerez)).toBe(
        "PASSWORD_CONTAINS_PERSONAL_INFO",
      );
      expect(checkPasswordPolicy("juanperez2026 en la playa", juanPerez)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
      expect(checkPasswordPolicy("donjuanperezoso en la playa", juanPerez)).toBeNull();
    });

    it("ignores 'mx' (2 letters, below MIN_PERSONAL_WORD_LENGTH = 3)", () => {
      expect(checkPasswordPolicy("tacos de mx al pastor hoy", juan)).toBeNull();
    });

    it("accepts 'perezoso' (contains 'perez' but is another word)", () => {
      expect(checkPasswordPolicy("el gato perezoso duerme mucho", juan)).toBeNull();
    });

    it("does not look at the domain of the email", () => {
      expect(checkPasswordPolicy("la empresa vende tacos al pastor", juan)).toBeNull();
    });

    it("works with no email at all", () => {
      expect(checkPasswordPolicy("juan come tacos al pastor", {})).toBeNull();
    });
  });

  describe("compound last name 'De la Cruz'", () => {
    const cruz: PasswordContext = { firstName: "Maria", lastName: "De la Cruz" };

    it("'de' and 'la' (2 letters) do not reject ordinary Spanish phrases", () => {
      expect(checkPasswordPolicy("de la mancha hasta la playa", cruz)).toBeNull();
    });

    it("'cruz' is rejected as a whole word", () => {
      expect(checkPasswordPolicy("la cruz del sur brilla hoy", cruz)).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("'cruzada' (contains cruz) is accepted", () => {
      expect(checkPasswordPolicy("la cruzada del sur brilla hoy", cruz)).toBeNull();
    });
  });

  describe("words about the service", () => {
    it("rejects 'leave manager' as two words", () => {
      expect(checkPasswordPolicy("leave manager es genial hoy")).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("rejects 'Leave-Manager' and 'leavemanager' (written together or with separators)", () => {
      expect(checkPasswordPolicy("Leave-Manager es genial hoy")).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
      expect(checkPasswordPolicy("leavemanager es genial hoy")).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("rejects 'vacaciones' as a whole word, also in uppercase", () => {
      expect(checkPasswordPolicy("vacaciones en la playa siempre")).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
      expect(checkPasswordPolicy("VACACIONES en la playa siempre")).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
    });

    it("accepts 'leave' or 'manager' on their own", () => {
      expect(checkPasswordPolicy("never leave the kitchen open")).toBeNull();
      expect(checkPasswordPolicy("the manager of the kitchen")).toBeNull();
    });

    // The service name is two consecutive whole words, never a substring.
    it("accepts 'please leave managerial duties' (leave + managerial is not the service name)", () => {
      expect(checkPasswordPolicy("please leave managerial duties")).toBeNull();
    });
  });
});

describe("checkPasswordPolicy: order of the checks", () => {
  it("reports TOO_SHORT before personal info", () => {
    expect(checkPasswordPolicy("ana come", { firstName: "Ana" })).toBe("PASSWORD_TOO_SHORT");
  });

  it("reports TOO_COMMON before personal info", () => {
    expect(checkPasswordPolicy("abcddesignbuild", { firstName: "Abcddesignbuild" })).toBe("PASSWORD_TOO_COMMON");
  });
});
