using System.Text.Json;
using ClassIsland.Control.Plugin.Services;

var path = args.Length > 0
    ? args[0]
    : Path.Combine(AppContext.BaseDirectory, "jcs-vectors.json");
using var document = JsonDocument.Parse(File.ReadAllText(path));
var vectors = document.RootElement.GetProperty("vectors");
var total = 0;
var failures = 0;
foreach (var vector in vectors.EnumerateArray())
{
    total++;
    var name = vector.GetProperty("name").GetString()!;
    var input = vector.GetProperty("input").GetString()!;
    var expected = vector.GetProperty("expected").GetString()!;
    string actual;
    try
    {
        using var parsed = JsonDocument.Parse(input);
        actual = Jcs.Canonicalize(parsed.RootElement);
    }
    catch (Exception exception)
    {
        Console.WriteLine($"FAIL {name}: threw {exception.GetType().Name}: {exception.Message}");
        failures++;
        continue;
    }
    if (actual == expected)
    {
        Console.WriteLine($"PASS {name}");
    }
    else
    {
        Console.WriteLine($"FAIL {name}\n  expected: {expected}\n  actual:   {actual}");
        failures++;
    }
}
Console.WriteLine($"{total - failures}/{total} RFC 8785 vectors matched");
return failures == 0 ? 0 : 1;